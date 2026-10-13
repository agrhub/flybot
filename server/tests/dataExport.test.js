const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { unzipSync, strFromU8 } = require('fflate');
const { models, startDb, stopDb, clearDb, request, createUser, createCamera } = require('./dbHelpers');
const { csvCell } = require('../src/services/dataExportService');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const unzip = async (res) => {
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    return Object.fromEntries(Object.entries(files).map(([name, data]) => [name, strFromU8(data)]));
};

test('a CSV cell: quoted when needed, and never run as a spreadsheet formula', () => {
    assert.equal(csvCell('Bẫy A1'), 'Bẫy A1');
    assert.equal(csvCell('a, b'), '"a, b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
    assert.equal(csvCell('-3'), "'-3");
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(new Date('2026-10-01T00:00:00Z')), '2026-10-01T00:00:00.000Z');
});

test('my data: a ZIP with only what I own, no password or secret link', async () => {
    const me = await createUser({ role: 'manager', name: 'Lan', email: 'lan@example.test' });
    const other = await createUser({ role: 'manager' });
    const farm = await models.Farm.create({ ownerId: me._id, name: 'Mango farm' });
    await models.Farm.create({ ownerId: other._id, name: 'Not yours' });
    const plot = await models.Plot.create({ farmId: farm._id, name: 'Plot A', areaHa: 1.5 });
    await createCamera(me, { deviceSerial: 'M1', deviceName: '=Mango, trap', farmId: farm._id, plotId: plot._id });
    await createCamera(other, { deviceSerial: 'X1' });
    await models.DailyStat.insertMany([
        { deviceSerial: 'M1', day: '2026-10-01', scans: 4, total: 12, peak: 12, min: 0, species: [{ name: 'fruit_fly', total: 12 }] },
        { deviceSerial: 'X1', day: '2026-10-01', scans: 4, total: 99, peak: 99, min: 0, species: [] }
    ]);
    await models.Snapshot.create([
        { deviceSerial: 'M1', imageUrl: 'u', s3Key: 'k1', aiProcessed: true, pestCount: 7, aiResults: { summary: { fruit_fly: 7 } } },
        { deviceSerial: 'X1', imageUrl: 'u', s3Key: 'k2', aiProcessed: true, pestCount: 50 }
    ]);
    await models.Treatment.create([
        { cameraSerials: ['M1'], type: 'spray', at: new Date('2026-09-20'), product: 'Radiant 60SC', createdBy: me._id },
        { cameraSerials: ['X1'], type: 'spray', at: new Date('2026-09-21'), product: 'Secret product', createdBy: other._id }
    ]);
    await models.MaintenanceEvent.create({ deviceSerial: 'M1', type: 'card_replaced', at: new Date('2026-09-25'), userId: me._id });
    await models.Dashboard.create({ ownerId: me._id, name: 'Weekly', visibility: 'public', publicToken: 'tok-secret-123' });
    await models.Dashboard.create({ ownerId: other._id, name: 'Their report' });

    const res = await request('/api/auth/export', { as: me });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.match(res.headers.get('content-disposition'), /attachment; filename="FlyBot_data_\d{4}-\d{2}-\d{2}\.zip"/);
    const files = await unzip(res);
    assert.deepEqual(Object.keys(files).sort(), ['README.txt', 'account.json', 'assistant.json', 'cameras.csv', 'daily_stats.csv',
        'detections.csv', 'farms.json', 'maintenance.csv', 'reports.json', 'treatments.csv']);

    const account = JSON.parse(files['account.json']);
    assert.equal(account.email, 'lan@example.test');
    assert.equal(account.password, undefined);
    assert.ok(!Object.values(files).some(text => text.includes('$2')), 'no password hash anywhere');

    assert.match(files['cameras.csv'], /M1,"'=Mango, trap",sticky,.*Mango farm,Plot A/);
    assert.ok(!files['cameras.csv'].includes('X1'));
    assert.deepEqual(JSON.parse(files['farms.json']).map(f => f.name), ['Mango farm']);
    assert.equal(JSON.parse(files['farms.json'])[0].plots[0].areaHa, 1.5);
    assert.match(files['daily_stats.csv'], /2026-10-01,M1,12,12,4,fruit_fly:12/);
    assert.ok(!files['daily_stats.csv'].includes('X1'));
    assert.match(files['detections.csv'], /,M1,yes,7,fruit_fly:7,/);
    assert.ok(!files['detections.csv'].includes('X1'));
    assert.match(files['treatments.csv'], /Radiant 60SC/);
    assert.ok(!files['treatments.csv'].includes('Secret product'));
    assert.match(files['maintenance.csv'], /M1,card_replaced,manual/);
    const reports = JSON.parse(files['reports.json']);
    assert.deepEqual(reports.map(r => r.name), ['Weekly']);
    assert.ok(!files['reports.json'].includes('tok-secret-123'), 'the public link is not in the file');

    // Written once the file is sent
    let audit = null;
    for (let i = 0; i < 20 && !audit; i++) {
        audit = await models.AuditLog.findOne({ action: 'auth.data_exported' }).lean();
        if (!audit) await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(String(audit?.actorId), String(me._id));
});

test('my data: signed in only, 3 times an hour', async () => {
    assert.equal((await request('/api/auth/export')).status, 401);
    const me = await createUser();
    for (let i = 0; i < 3; i++) {
        const res = await request('/api/auth/export', { as: me });
        assert.equal(res.status, 200);
        await res.arrayBuffer();
    }
    assert.equal((await request('/api/auth/export', { as: me })).status, 429);
});
