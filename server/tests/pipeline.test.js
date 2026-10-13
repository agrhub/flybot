const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { models, startDb, stopDb, clearDb, createUser, createCamera } = require('./dbHelpers');
const { s3Client } = require('../src/config/s3');
const aiService = require('../src/services/aiService');
const ezvizService = require('../src/services/ezvizService');
const dailyStats = require('../src/services/dailyStats');
const { findOrphanFiles } = require('../src/services/orphanFiles');
const { retryFailedAnalyses, captureAndSaveSnapshot } = require('../src/cron/captureJob');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const MIN = 60 * 1000;
const photo = (serial, minutesAgo, extra = {}) => models.Snapshot.create({
    deviceSerial: serial, imageUrl: 'x', s3Key: `snapshots/${serial}/${serial}_${minutesAgo}.jpg`,
    createdAt: new Date(Date.now() - minutesAgo * MIN), ...extra
});

test('photos the AI failed on are analyzed again from S3, a few times at most', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'RTY1' });
    const failed = await photo('RTY1', 60);
    const exhausted = await photo('RTY1', 70, { aiRetries: 3 });
    const tooNew = await photo('RTY1', 2);
    const tooOld = await photo('RTY1', 8 * 60);

    const original = aiService.analyzeSnapshot;
    const seen = [];
    aiService.analyzeSnapshot = async (base64, id) => {
        seen.push({ id: String(id), image: Buffer.from(base64, 'base64').toString() });
        await models.Snapshot.updateOne({ _id: id }, { $set: { aiProcessed: true, pestCount: 4, aiResults: { summary: { fruit_fly: 4 } } } });
        return true;
    };
    try {
        const result = await retryFailedAnalyses();
        assert.deepEqual(result, { retried: 1, succeeded: 1 });
        assert.deepEqual(seen, [{ id: String(failed._id), image: 'JPEGDATA' }], 'image read back from S3');
        const after = await models.Snapshot.findById(failed._id).lean();
        assert.equal(after.aiProcessed, true);
        assert.equal(after.aiRetries, 1);
        for (const skipped of [exhausted, tooNew, tooOld]) {
            assert.equal((await models.Snapshot.findById(skipped._id).lean()).aiProcessed, false);
        }

        // Still failing: counted each time, then left alone
        aiService.analyzeSnapshot = async () => false;
        const again = await photo('RTY1', 90);
        for (let i = 0; i < 4; i++) await retryFailedAnalyses();
        assert.equal((await models.Snapshot.findById(again._id).lean()).aiRetries, 3);
    } finally {
        aiService.analyzeSnapshot = original;
    }
});

test('a capture whose database save fails removes the file it uploaded', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'ORP1' });
    const originals = { capture: ezvizService.captureDevice, get: axios.get, send: s3Client.send, save: models.Snapshot.prototype.save };
    const commands = [];
    ezvizService.captureDevice = async () => ({ code: '200', data: { picUrl: 'https://camera.example.test/pic.jpg' } });
    axios.get = async () => ({ data: Buffer.from('JPEGDATA') });
    s3Client.send = async (command) => {
        commands.push({ name: command.constructor.name, key: command.input.Key });
        return {};
    };
    models.Snapshot.prototype.save = async () => { throw new Error('database down'); };
    try {
        assert.equal(await captureAndSaveSnapshot('ORP1'), null);
        assert.deepEqual(commands.map(c => c.name), ['PutObjectCommand', 'DeleteObjectCommand']);
        assert.equal(commands[0].key, commands[1].key);
    } finally {
        ezvizService.captureDevice = originals.capture;
        axios.get = originals.get;
        s3Client.send = originals.send;
        models.Snapshot.prototype.save = originals.save;
    }
});

test('daily statistics refreshed side by side for one camera end up complete', async () => {
    const docs = await models.Snapshot.insertMany([5, 6, 7].map(n => ({
        deviceSerial: 'SEQ1', imageUrl: 'x', s3Key: `k${n}`, aiProcessed: true,
        createdAt: new Date(Date.now() - n * MIN), aiResults: { summary: { fruit_fly: n } }
    })));
    await Promise.all(docs.map(d => dailyStats.refreshForSnapshot(d)));
    const row = await models.DailyStat.findOne({ deviceSerial: 'SEQ1' }).lean();
    assert.equal(row.scans, 3);
    assert.equal(row.peak, 7);
});

test('orphan file report: files no snapshot points to, recent uploads left out', async () => {
    await photo('ORF1', 5000);
    const old = new Date(Date.now() - 3 * 24 * 60 * MIN);
    const original = s3Client.send;
    s3Client.send = async ({ input }) => {
        if (input.Delimiter) return { CommonPrefixes: [{ Prefix: 'snapshots/ORF1/' }, { Prefix: 'snapshots/GONE/' }], IsTruncated: false };
        if (input.Prefix === 'snapshots/ORF1/' && !input.ContinuationToken) {
            return {
                Contents: [
                    { Key: 'snapshots/ORF1/ORF1_5000.jpg', Size: 100, LastModified: old },
                    { Key: 'snapshots/ORF1/lost.jpg', Size: 200, LastModified: old }
                ],
                IsTruncated: true, NextContinuationToken: 'page2'
            };
        }
        if (input.Prefix === 'snapshots/ORF1/') return { Contents: [{ Key: 'snapshots/ORF1/uploading.jpg', Size: 50, LastModified: new Date() }], IsTruncated: false };
        return { Contents: [{ Key: 'snapshots/GONE/a.jpg', Size: 300, LastModified: old }], IsTruncated: false };
    };
    try {
        const result = await findOrphanFiles();
        assert.equal(result.scanned, 4);
        assert.deepEqual(result.orphans.map(o => o.key), ['snapshots/ORF1/lost.jpg', 'snapshots/GONE/a.jpg']);
        assert.equal(result.bytes, 500);
        assert.deepEqual(result.byCamera, { ORF1: 1, GONE: 1 });
    } finally {
        s3Client.send = original;
    }
});

test('admin pipeline monitor: photos by hour, retry queue, problem cameras and job runs', async () => {
    const { request } = require('./dbHelpers');
    const jobStatus = require('../src/services/jobStatus');
    const admin = await createUser({ role: 'admin' });
    await createCamera(admin, { deviceSerial: 'MON1', deviceName: 'Trap A' });
    await createCamera(admin, { deviceSerial: 'MON2', deviceName: 'Trap B' });
    await photo('MON1', 60, { aiProcessed: true, pestCount: 2 });
    await photo('MON1', 90, { aiProcessed: true, pestCount: 2, aiRetries: 1 });
    await photo('MON1', 120); // failed, waiting for a retry
    await photo('MON1', 150, { aiRetries: 3 }); // given up
    await photo('MON1', 3); // still being analyzed
    await jobStatus.track('cleanup', async () => ({ photos: 5, more: false }));
    await assert.rejects(jobStatus.track('aiRetry', async () => { throw new Error('S3 down'); }));

    const res = await request('/api/admin/pipeline', { as: admin });
    assert.equal(res.status, 200);
    const { pipeline } = await res.json();
    assert.deepEqual(pipeline.totals, { photos: 5, analyzed: 2, failed: 2, recovered: 1, waitingRetry: 1, gaveUp: 1 });
    assert.equal(pipeline.hours.length, 24);
    assert.equal(pipeline.hours.reduce((sum, h) => sum + h.photos, 0), 5);
    assert.deepEqual(pipeline.cameras.map(c => [c.deviceSerial, c.problems]), [['MON1', ['failing']], ['MON2', ['noPhotos']]]);
    const jobs = Object.fromEntries(pipeline.jobs.map(j => [j.id, j]));
    assert.deepEqual(jobs.cleanup.last.result, { photos: 5, more: false });
    assert.equal(jobs.aiRetry.last.ok, false);
    assert.equal(jobs.aiRetry.last.error, 'S3 down');

    const manager = await createUser({ role: 'manager' });
    assert.equal((await request('/api/admin/pipeline', { as: manager })).status, 403);
});
