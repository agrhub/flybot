const { PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { s3Client } = require('../config/s3');
const { S3_BUCKET } = require('../config/env');
const { Snapshot } = require('../models');

async function getSignedDownloadUrl(objectKey) {
    try {
        const command = new GetObjectCommand({
            Bucket: S3_BUCKET,
            Key: objectKey
        });

        const url = await getSignedUrl(s3Client, command, {
            expiresIn: 3600 // URL valid for 1 hour
        });

        return url;
    } catch (err) {
        console.error("getSignedDownloadUrl error:", err.message, objectKey);
        return null;
    }
}

async function uploadSnapshot(s3Key, buffer, contentType = 'image/jpeg') {
    return await s3Client.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        Body: buffer,
        ContentType: contentType
    }));
}

async function getS3Object(key) {
    const command = new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: key
    });
    return await s3Client.send(command);
}

/** A stored file's content as a Buffer. */
async function readS3Buffer(key) {
    const object = await getS3Object(key);
    if (object.Body?.transformToByteArray) return Buffer.from(await object.Body.transformToByteArray());
    const chunks = [];
    for await (const chunk of object.Body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}

async function deleteS3Object(key) {
    return s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
}

// Photos removed per batch: S3 DeleteObjects takes at most 1000 keys
const CLEANUP_BATCH = 1000;
// Per hourly run, so a large backlog (e.g. after shortening the retention) is spread over several
// runs instead of one long burst against the database and S3
const CLEANUP_MAX_PER_RUN = 50000;
const CLEANUP_PAUSE_MS = 200;
const CLEANUP_MAX_KEPT = 5000;
// Daily statistics are one small row per camera per day. They are kept long enough for a
// 12-month report compared with the 12 months before, whatever the photo retention is
const ROLLUP_MIN_MONTHS = 25;

const monthsAgo = (months, now) => {
    const date = new Date(now);
    date.setMonth(date.getMonth() - months);
    return date;
};

/**
 * Remove photos older than the retention period (admin setting) from S3 and the database, and
 * daily statistics older than both the retention and ROLLUP_MIN_MONTHS. A photo's row is only
 * removed once its file is gone from S3, so a failed delete is retried on the next run instead of
 * leaving a file nothing points to. Reviewed photos still waiting for the training upload stay.
 * Returns { photos, files, failed, more }.
 */
async function cleanupOldData({ now = new Date(), maxPerRun = CLEANUP_MAX_PER_RUN, pauseMs = CLEANUP_PAUSE_MS } = {}) {
    const { DailyStat } = require('../models');
    const { dayKeyOf } = require('./dailyStats');
    const { retentionMonths } = await require('./settingsService').getSettings();
    const cutoff = monthsAgo(retentionMonths, now);
    const rollupMonths = Math.max(retentionMonths, ROLLUP_MIN_MONTHS);

    const stats = await DailyStat.deleteMany({ day: { $lt: dayKeyOf(monthsAgo(rollupMonths, now)) } });
    const result = { photos: 0, files: 0, failed: 0, more: false };
    // Photos kept back in this run (failed deletes), so they are not read again
    const kept = [];
    for (;;) {
        // A run stops at its quota, or when S3 keeps refusing (tried again next run)
        if (result.photos >= maxPerRun || kept.length >= CLEANUP_MAX_KEPT) {
            result.more = true;
            break;
        }
        const filter = { createdAt: { $lt: cutoff }, 'trainingSync.status': { $ne: 'pending' } };
        if (kept.length) filter._id = { $nin: kept };
        // Oldest first along the { createdAt } index: removed rows drop out of the next batch
        const size = Math.min(CLEANUP_BATCH, maxPerRun - result.photos);
        const batch = await Snapshot.find(filter).sort({ createdAt: 1 }).hint({ createdAt: 1 })
            .select('_id s3Key').limit(size).lean();
        if (!batch.length) break;

        const keys = [...new Set(batch.map(r => r.s3Key).filter(Boolean))];
        const failedKeys = new Set();
        if (keys.length) {
            const res = await s3Client.send(new DeleteObjectsCommand({
                Bucket: S3_BUCKET,
                // Quiet: the response lists only the keys that could not be deleted
                Delete: { Objects: keys.map(Key => ({ Key })), Quiet: true }
            }));
            const errors = (res?.Errors || []).filter(e => e.Code !== 'NoSuchKey'); // already gone is fine
            errors.forEach(e => failedKeys.add(e.Key));
            if (errors.length) {
                console.warn(`⚠️ Cleanup: ${errors.length} file(s) could not be deleted from S3 (${errors[0].Code}: ${errors[0].Message}); kept for the next run.`);
            }
            result.files += keys.length - failedKeys.size;
        }
        const removable = [];
        for (const r of batch) (failedKeys.has(r.s3Key) ? kept : removable).push(r._id);
        result.failed = kept.length;
        if (removable.length) result.photos += (await Snapshot.deleteMany({ _id: { $in: removable } })).deletedCount;
        if (batch.length < size) break;
        // Let captures and requests use the database between batches
        await new Promise(resolve => setTimeout(resolve, pauseMs));
    }

    if (stats.deletedCount || result.photos || result.failed) {
        const parts = [`${result.photos} photo(s) and ${result.files} file(s) older than ${retentionMonths} month(s) removed`];
        if (result.failed) parts.push(`${result.failed} kept (S3 delete failed)`);
        if (stats.deletedCount) parts.push(`${stats.deletedCount} daily statistic row(s) older than ${rollupMonths} months removed`);
        console.log(`🧹 Cleanup: ${parts.join(', ')}${result.more ? '; more on the next run' : ''}.`);
    }
    return result;
}

module.exports = {
    getSignedDownloadUrl,
    uploadSnapshot,
    getS3Object,
    readS3Buffer,
    deleteS3Object,
    cleanupOldData
};
