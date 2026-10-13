const axios = require('axios');
const { Snapshot } = require('../models');
const env = require('../config/env');
const { readS3Buffer } = require('./s3Service');
const settingsService = require('./settingsService');
const { getImageDimensions } = require('./aiService');
const { countPests } = require('./notificationService');

/**
 * Send human-reviewed snapshots to the Roboflow project, so the detector can be retrained
 * on the farm's own photos.
 *
 * - confirmed: the AI boxes were right, so the photo goes up already labeled
 * - corrected: only the counts were fixed (no boxes), so the photo goes up unlabeled in its
 *   own batch, tagged with the right count, for labeling in Roboflow
 *
 * Off unless an admin turns it on and ROBOFLOW_UPLOAD_PROJECT is set.
 */
const API = 'https://api.roboflow.com';
const BATCH_SIZE = 20;
const MAX_ATTEMPTS = 5;
const BATCH_NAMES = { confirmed: 'flybot-confirmed', corrected: 'flybot-corrections' };

const uploadKey = () => env.ROBOFLOW_UPLOAD_API_KEY || env.ROBOFLOW_API_KEY;
const isConfigured = () => !!(env.ROBOFLOW_UPLOAD_PROJECT && uploadKey());

const toObject = (m) => (m instanceof Map ? Object.fromEntries(m) : (m || {}));

/** Roboflow "CreateML" JSON for the AI boxes (pixel [xmin, ymin, xmax, ymax]). */
function createMlAnnotation(name, insects) {
    return [{
        image: name,
        annotations: (insects || [])
            .filter(i => Array.isArray(i.bbox) && i.bbox.length === 4)
            .map(({ bbox: [xmin, ymin, xmax, ymax] }) => ({
                label: env.ROBOFLOW_UPLOAD_CLASS,
                coordinates: { x: (xmin + xmax) / 2, y: (ymin + ymax) / 2, width: xmax - xmin, height: ymax - ymin }
            }))
    }];
}

/**
 * Upload one reviewed snapshot. Returns the Roboflow image id.
 */
async function uploadSnapshot(snapshot) {
    const status = snapshot.review.status;
    const name = `${snapshot._id}.jpg`;
    const image = await readS3Buffer(snapshot.s3Key);
    const count = countPests(toObject(snapshot.aiResults?.summary));
    const original = countPests(toObject(snapshot.review.originalSummary));

    const params = new URLSearchParams({ api_key: uploadKey(), name, split: 'train', batch: BATCH_NAMES[status] });
    for (const tag of [`review-${status}`, `count-${count}`, `ai-count-${original}`, `camera-${snapshot.deviceSerial}`]) {
        params.append('tag', tag);
    }
    const { data } = await axios.post(`${API}/dataset/${encodeURIComponent(env.ROBOFLOW_UPLOAD_PROJECT)}/upload?${params}`, image.toString('base64'), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        maxBodyLength: 20 * 1024 * 1024,
        timeout: 30000
    });
    const imageId = data?.id;
    if (!imageId) throw new Error(data?.error?.message || data?.message || 'No image id in the upload response');

    // Confirmed: the AI boxes are the labels
    const insects = snapshot.aiResults?.insects || [];
    if (status === 'confirmed' && insects.length) {
        const { width, height } = getImageDimensions(image);
        const valid = insects.every(i => Array.isArray(i.bbox) && i.bbox[2] <= width * 1.05 && i.bbox[3] <= height * 1.05);
        if (valid) {
            const annotateParams = new URLSearchParams({ api_key: uploadKey(), name: `${snapshot._id}.json` });
            await axios.post(`${API}/dataset/${encodeURIComponent(env.ROBOFLOW_UPLOAD_PROJECT)}/annotate/${encodeURIComponent(imageId)}?${annotateParams}`,
                JSON.stringify(createMlAnnotation(name, insects)),
                { headers: { 'Content-Type': 'text/plain' }, timeout: 30000 });
        }
    }
    return imageId;
}

/**
 * Upload the next pending reviewed snapshots. Returns { uploaded, failed, skipped } or null when off.
 */
async function syncPending({ force = false } = {}) {
    if (!isConfigured()) return null;
    if (!force && !(await settingsService.getSettings()).trainingSync) return null;

    const pending = await Snapshot.find({ 'trainingSync.status': 'pending', 'trainingSync.attempts': { $lt: MAX_ATTEMPTS } })
        .sort({ 'review.reviewedAt': 1 })
        .limit(BATCH_SIZE);
    const result = { uploaded: 0, failed: 0 };
    for (const snapshot of pending) {
        try {
            if (!snapshot.review?.status) throw new Error('Not reviewed');
            const imageId = await uploadSnapshot(snapshot);
            await Snapshot.updateOne({ _id: snapshot._id }, {
                $set: { 'trainingSync.status': 'uploaded', 'trainingSync.imageId': imageId, 'trainingSync.uploadedAt': new Date(), 'trainingSync.error': null },
                $inc: { 'trainingSync.attempts': 1 }
            });
            result.uploaded++;
        } catch (err) {
            const message = err.response?.data?.error?.message || err.response?.data?.message || err.message;
            const attempts = (snapshot.trainingSync?.attempts || 0) + 1;
            await Snapshot.updateOne({ _id: snapshot._id }, {
                $set: { 'trainingSync.status': attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', 'trainingSync.error': String(message).slice(0, 300) },
                $inc: { 'trainingSync.attempts': 1 }
            });
            result.failed++;
            console.warn(`⚠️ Training upload failed (${snapshot._id}):`, message);
        }
    }
    if (pending.length) console.log(`🧠 Training sync: ${result.uploaded} uploaded, ${result.failed} failed.`);
    return result;
}

/** Queue a snapshot after a review (a new review re-sends it). */
function markPending(snapshot) {
    snapshot.set('trainingSync', { status: 'pending', attempts: 0, error: null, imageId: snapshot.trainingSync?.imageId || null });
}

/** Counts per state, for the admin page. */
async function stats() {
    const rows = await Snapshot.aggregate([
        { $match: { 'trainingSync.status': { $exists: true } } },
        { $group: { _id: '$trainingSync.status', count: { $sum: 1 } } }
    ]);
    const counts = { pending: 0, uploaded: 0, failed: 0 };
    for (const r of rows) counts[r._id] = r.count;
    const lastError = await Snapshot.findOne({ 'trainingSync.status': 'failed' }).sort({ 'review.reviewedAt': -1 }).select('trainingSync.error').lean();
    return {
        configured: isConfigured(),
        project: env.ROBOFLOW_UPLOAD_PROJECT || null,
        enabled: !!(await settingsService.getSettings()).trainingSync,
        counts,
        lastError: lastError?.trainingSync?.error || null
    };
}

/** Give failed uploads another round of attempts. */
async function retryFailed() {
    const res = await Snapshot.updateMany({ 'trainingSync.status': 'failed' }, { $set: { 'trainingSync.status': 'pending', 'trainingSync.attempts': 0 } });
    return res.modifiedCount || 0;
}

module.exports = {
    isConfigured,
    createMlAnnotation,
    uploadSnapshot,
    syncPending,
    markPending,
    stats,
    retryFailed
};
