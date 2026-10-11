const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { s3Client } = require('../config/s3');
const { S3_BUCKET } = require('../config/env');
const { Snapshot } = require('../models');

/**
 * Photo files in S3 that no snapshot points to (e.g. a capture whose database save failed, or
 * rows removed by hand). Read-only: lists the bucket under `prefix` and compares each camera
 * folder with that camera's snapshots. Files newer than `minAgeMs` are skipped, since a capture
 * in progress uploads its file before saving the row.
 * Returns { scanned, orphans: [{ key, size, lastModified }], bytes, byCamera: { serial: n } }.
 */
async function findOrphanFiles({ prefix = 'snapshots/', minAgeMs = 60 * 60 * 1000, now = new Date(), onCamera = () => {} } = {}) {
    const result = { scanned: 0, orphans: [], bytes: 0, byCamera: {} };
    const newest = now.getTime() - minAgeMs;

    // Every page of a listing; `each(page)` gets the S3 response
    const list = async (input, each) => {
        let token;
        do {
            const page = await s3Client.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, ...input, ContinuationToken: token }));
            await each(page);
            token = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (token);
    };
    const check = (objects, known, serial) => {
        for (const obj of objects) {
            result.scanned++;
            if (known.has(obj.Key) || new Date(obj.LastModified).getTime() > newest) continue;
            result.orphans.push({ key: obj.Key, size: obj.Size || 0, lastModified: obj.LastModified });
            result.bytes += obj.Size || 0;
            result.byCamera[serial] = (result.byCamera[serial] || 0) + 1;
        }
    };

    // Camera folders: snapshots/<serial>/
    const folders = [];
    const loose = [];
    await list({ Prefix: prefix, Delimiter: '/' }, (page) => {
        folders.push(...(page.CommonPrefixes || []).map(p => p.Prefix));
        loose.push(...(page.Contents || []));
    });
    if (loose.length) {
        const known = new Set((await Snapshot.find({ s3Key: { $in: loose.map(o => o.Key) } }).select('s3Key').lean()).map(s => s.s3Key));
        check(loose, known, '(none)');
    }

    for (const folder of folders) {
        const serial = folder.slice(prefix.length, -1);
        // This camera's stored keys, read along the { deviceSerial, createdAt } index
        const known = new Set();
        const cursor = Snapshot.collection.find({ deviceSerial: serial }, { projection: { _id: 0, s3Key: 1 } });
        for await (const doc of cursor) known.add(doc.s3Key);
        await list({ Prefix: folder }, (page) => check(page.Contents || [], known, serial));
        onCamera(serial, result);
    }
    return result;
}

module.exports = { findOrphanFiles };
