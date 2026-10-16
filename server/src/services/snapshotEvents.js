const { Camera, Snapshot } = require('../models');
const { trapKindOf } = require('../constants/trap');
const { pestCountOf } = require('../models/Snapshot');
const s3Service = require('./s3Service');
const webhookService = require('./webhookService');
const { readImageSize } = require('./aiService');

/**
 * Webhook event `snapshot_analyzed`: one per photo, once its AI result and its quality check
 * are both stored, so an outside system (FlyBot Sentinel) can fetch the photo and act on it.
 * Unlike the alerts it is not a notification (nothing in the bell, no email): it goes only to
 * the webhooks that subscribe to it, of the people who can see the camera.
 *
 * The photo link is a presigned S3 GET valid IMAGE_URL_TTL_S seconds: the bucket is private
 * (DEPLOY.md) and object keys are predictable, so no public URL is ever sent.
 */
const EVENT = 'snapshot_analyzed';
const IMAGE_URL_TTL_S = 3600;
const MAX_BOXES = 200;

const toPlain = (map) => {
    if (!map) return {};
    return map instanceof Map ? Object.fromEntries(map) : { ...map };
};
const idOrNull = (value) => (value ? String(value) : null);
const numOrNull = (value) => (Number.isFinite(value) ? value : null);

function qualityOf(quality) {
    if (!quality?.checkedAt) return null;
    return {
        brightness: numOrNull(quality.brightness),
        contrast: numOrNull(quality.contrast),
        sharpness: numOrNull(quality.sharpness),
        clipped: numOrNull(quality.clipped),
        coverage: numOrNull(quality.coverage),
        issues: quality.issues || [],
        checkedAt: quality.checkedAt
    };
}

/**
 * Detection boxes as stored: pixels of the photo, [xmin, ymin, xmax, ymax]. At most MAX_BOXES,
 * highest confidence first, with `truncated` when some were left out.
 */
function boxesOf(insects = []) {
    const valid = insects.filter(i => Array.isArray(i?.bbox) && i.bbox.length === 4);
    const sorted = [...valid].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    return {
        boxes: sorted.slice(0, MAX_BOXES).map(i => ({
            label: i.name || null,
            confidence: numOrNull(i.confidence),
            bbox: i.bbox.map(Number)
        })),
        boxesTotal: valid.length,
        truncated: valid.length > MAX_BOXES
    };
}

// Snapshot.aiProvider 'device' = counted on the camera itself (CamOS AI camera)
const aiSourceOf = (snapshot) => (snapshot.aiProvider === 'device' ? 'device' : 'cloud');
const providerOf = (camera, snapshot) => camera.provider || (snapshot.aiProvider === 'device' ? 'camos' : 'ezviz');

/**
 * The latest analyzed photo of the same camera taken before this one (by capture time, so a
 * photo analyzed late on the retry path still points at the one before it).
 */
async function previousSnapshotId(snapshot) {
    const previous = await Snapshot.findOne({
        deviceSerial: snapshot.deviceSerial,
        aiProcessed: true,
        createdAt: { $lt: snapshot.createdAt }
    }).sort({ createdAt: -1 }).select('_id').lean();
    return idOrNull(previous?._id);
}

/**
 * The event body for one analyzed snapshot (a lean document), or null when it has no AI
 * result (yet) or its camera is gone. `buffer`: the photo, to read its size (optional).
 * `pending` (AI_PROVIDER=sentinel): sent before any AI result, with aiSource "pending",
 * count null and no boxes, so Sentinel can analyze the photo itself.
 */
async function buildPayload(snapshot, { buffer = null, camera = null, pending = false } = {}) {
    const waiting = pending && !snapshot?.aiProcessed;
    if (!snapshot || (!snapshot.aiProcessed && !waiting)) return null;
    camera = camera || await Camera.findOne({ deviceSerial: snapshot.deviceSerial }).lean();
    if (!camera) return null;

    const size = buffer ? readImageSize(buffer) : null;
    const counts = toPlain(snapshot.aiResults?.summary);
    const [imageUrl, previousId] = await Promise.all([
        s3Service.getSignedDownloadUrl(snapshot.s3Key, IMAGE_URL_TTL_S),
        previousSnapshotId(snapshot)
    ]);
    const now = new Date();
    return {
        id: `snap_${snapshot._id}`,
        event: EVENT,
        createdAt: now,
        deviceSerial: snapshot.deviceSerial,
        severity: 'info',
        params: {
            snapshotId: String(snapshot._id),
            deviceSerial: snapshot.deviceSerial,
            deviceName: camera.deviceName || snapshot.deviceSerial,
            provider: providerOf(camera, snapshot),
            trapKind: trapKindOf(camera),
            farmId: idOrNull(camera.farmId),
            plotId: idOrNull(camera.plotId),
            latitude: numOrNull(camera.latitude),
            longitude: numOrNull(camera.longitude),
            capturedAt: snapshot.createdAt,
            imageUrl,
            imageUrlExpiresAt: imageUrl ? new Date(now.getTime() + IMAGE_URL_TTL_S * 1000) : null,
            width: size?.width || null,
            height: size?.height || null,
            count: waiting ? null : (Number.isFinite(snapshot.pestCount) ? snapshot.pestCount : pestCountOf(counts)),
            counts: waiting ? {} : counts,
            aiSource: waiting ? 'pending' : aiSourceOf(snapshot),
            aiProvider: waiting ? null : (snapshot.aiProvider || null),
            boxFormat: 'xyxy_pixels',
            ...(waiting ? { boxes: [], boxesTotal: 0, truncated: false } : boxesOf(snapshot.aiResults?.insects)),
            trigger: snapshot.trigger || null,
            quality: qualityOf(snapshot.quality),
            previousSnapshotId: previousId,
            cardReplacedAt: camera.cardReplacedAt || null,
            alertThreshold: numOrNull(camera.alertThreshold)
        }
    };
}

/**
 * Send `snapshot_analyzed` for one snapshot to the subscribed webhooks of everyone who can see
 * its camera (owner and people it is shared with; the webhook service keeps managers and
 * admins only). Call it after both the AI result and the quality check are stored.
 * Returns the number of webhooks called; never throws.
 */
async function emitAnalyzed(snapshotId, { buffer = null, pending = false } = {}) {
    try {
        const snapshot = await Snapshot.findById(snapshotId).lean();
        if (!snapshot || (!snapshot.aiProcessed && !pending)) return 0;
        const camera = await Camera.findOne({ deviceSerial: snapshot.deviceSerial }).lean();
        if (!camera) return 0;
        const watchers = [camera.userId, ...(camera.sharedWith || []).map(sh => sh.userId)];
        const hooks = await webhookService.subscribers(watchers, EVENT);
        if (!hooks.length) return 0;
        const payload = await buildPayload(snapshot, { buffer, camera, pending });
        if (!payload) return 0;
        return await webhookService.deliverEvent(hooks, payload);
    } catch (err) {
        console.error(`⚠️ snapshot_analyzed webhook failed (${snapshotId}):`, err.message);
        return 0;
    }
}

module.exports = {
    EVENT,
    IMAGE_URL_TTL_S,
    MAX_BOXES,
    boxesOf,
    previousSnapshotId,
    buildPayload,
    emitAnalyzed
};
