const mongoose = require('mongoose');
const { PutObjectCommand, CopyObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const config = require('../src/config/env');
const { s3Client } = require('../src/config/s3');
const { Snapshot, Notification, MaintenanceEvent, SentinelProposal, ChatSession } = require('../src/models');
const dailyStats = require('../src/services/dailyStats');
const { deleteEvent } = require('../src/services/maintenanceService');

// Usage: node scripts/remove_snapshots.js <serial> <from YYYY-MM-DD> <to YYYY-MM-DD> [--apply]
// Removes one camera's photos taken on those local days (DEVICE_DEFAULT_TIMEZONE, both inclusive), for example
// bench tests before the trap went to the field, with what they caused: the count alerts about the camera, the
// card changes detected from them and the Sentinel proposals about this camera alone (with their cards in the
// owner's Sentinel conversation). Without --apply it only reports. With --apply it first writes a backup to the
// photo bucket under backup/<serial>-<from>-<to>-<time>/ (records.json + every photo at its own key; restore =
// copy the photos back, insert the records, node scripts/rebuild_daily_stats.js), then deletes and rebuilds the
// daily statistics of those days.

const DAY_MS = 24 * 60 * 60 * 1000;
// Notifications that come from the counts of the removed photos
const COUNT_NOTIFICATIONS = ['pest_threshold', 'pest_surge', 'card_change_detected', 'image_quality'];
const DELETE_BATCH = 1000;

const localNoon = (day) => new Date(`${day}T12:00:00Z`);

async function removeSnapshots({ serial, from, to, apply = false, s3 = s3Client, bucket = config.S3_BUCKET, now = new Date() }) {
    if (!serial || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
        throw new Error('usage: <serial> <from YYYY-MM-DD> <to YYYY-MM-DD> [--apply]');
    }
    // Day boundaries are local: query a day wider in UTC, then keep the local days asked for
    const window = { $gte: new Date(localNoon(from).getTime() - 2 * DAY_MS), $lte: new Date(localNoon(to).getTime() + 2 * DAY_MS) };
    const inRange = (date) => { const day = dailyStats.dayKeyOf(date); return day >= from && day <= to; };

    const snapshots = (await Snapshot.find({ deviceSerial: serial, createdAt: window }).sort({ createdAt: 1 }).lean())
        .filter(s => inRange(s.createdAt));
    const notifications = (await Notification.find({ deviceSerial: serial, type: { $in: COUNT_NOTIFICATIONS }, createdAt: window }).lean())
        .filter(n => inRange(n.createdAt));
    const events = (await MaintenanceEvent.find({ deviceSerial: serial, source: 'detected', at: window }).lean()).filter(e => inRange(e.at));
    // A proposal about several cameras stays: it is not only about this one's photos
    const proposals = (await SentinelProposal.find({ deviceSerials: serial, createdAt: window }).lean())
        .filter(p => inRange(p.createdAt) && p.deviceSerials.every(s => s === serial));
    const keys = [...new Set(snapshots.map(s => s.s3Key).filter(Boolean))];

    const byDay = {};
    for (const s of snapshots) {
        const d = byDay[dailyStats.dayKeyOf(s.createdAt)] ||= { photos: 0, pests: 0 };
        d.photos++;
        d.pests += s.pestCount || 0;
    }
    const report = {
        serial, from, to, apply,
        photos: snapshots.length, files: keys.length, pests: snapshots.reduce((n, s) => n + (s.pestCount || 0), 0),
        notifications: notifications.length, detectedEvents: events.length, proposals: proposals.length, byDay
    };
    if (!apply || !(snapshots.length + notifications.length + events.length + proposals.length)) return report;

    // 1. Backup: the records, then a copy of every photo. Any failure stops before anything is deleted.
    const prefix = `backup/${serial}-${from}-${to}-${now.toISOString().replace(/[:.]/g, '-')}/`;
    const records = { serial, from, to, removedAt: now.toISOString(), snapshots, notifications, maintenanceEvents: events, sentinelProposals: proposals };
    await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: `${prefix}records.json`, Body: JSON.stringify(records), ContentType: 'application/json'
    }));
    const missing = [];
    for (const key of keys) {
        try {
            await s3.send(new CopyObjectCommand({
                Bucket: bucket, Key: prefix + key, CopySource: `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`
            }));
        } catch (err) {
            if (err?.name !== 'NoSuchKey' && err?.Code !== 'NoSuchKey') throw err;
            missing.push(key); // already gone: nothing to back up or delete
        }
    }

    // 2. The photo files, then the records
    const present = keys.filter(k => !missing.includes(k));
    for (let i = 0; i < present.length; i += DELETE_BATCH) {
        const res = await s3.send(new DeleteObjectsCommand({
            Bucket: bucket, Delete: { Objects: present.slice(i, i + DELETE_BATCH).map(Key => ({ Key })), Quiet: true }
        }));
        const errors = (res?.Errors || []).filter(e => e.Code !== 'NoSuchKey');
        if (errors.length) throw new Error(`${errors.length} file(s) could not be deleted (${errors[0].Code}); the records are kept, re-run to finish`);
    }
    report.deleted = {
        photos: (await Snapshot.deleteMany({ _id: { $in: snapshots.map(s => s._id) } })).deletedCount,
        notifications: (await Notification.deleteMany({ _id: { $in: notifications.map(n => n._id) } })).deletedCount
    };
    for (const event of events) await deleteEvent(event); // also moves Camera.cardReplacedAt back
    report.deleted.detectedEvents = events.length;
    const cards = {};
    for (const p of proposals) (cards[`${p.userId}|${p.sessionId}`] ||= []).push(p.messageId);
    for (const [owner, ids] of Object.entries(cards)) {
        const [userId, sessionId] = owner.split('|');
        await ChatSession.updateOne({ userId, sessionId }, { $pull: { messages: { id: { $in: ids } } } });
    }
    report.deleted.proposals = (await SentinelProposal.deleteMany({ _id: { $in: proposals.map(p => p._id) } })).deletedCount;

    // 3. Daily statistics of those days, from what is left
    report.statDays = await dailyStats.rebuildRange(serial, localNoon(from), localNoon(to));
    report.backup = `${bucket}/${prefix}`;
    report.missingFiles = missing.length;
    return report;
}

async function main() {
    const [serial, from, to] = process.argv.slice(2).filter(a => !a.startsWith('--'));
    const apply = process.argv.includes('--apply');
    await mongoose.connect(config.MONGO_URI);
    const report = await removeSnapshots({ serial, from, to, apply });
    console.log(JSON.stringify(report, null, 1));
    if (!apply) console.log('Preview only: re-run with --apply to back up and remove.');
    await mongoose.disconnect();
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { removeSnapshots };
