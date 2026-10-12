const crypto = require('crypto');
const axios = require('axios');
const { CAMOS_WEBHOOK_SECRET } = require('../config/env');
const { Camera, Snapshot } = require('../models');
const notificationService = require('./notificationService');
const { getImageDimensions } = require('./aiService');
const { FRUIT_FLY, isFruitFly } = require('../constants/species');

/**
 * Events CamOS sends FlyBot (camos-ai-camera/protocol/open-api.md, section 4): camera status,
 * and the detections the cameras run themselves, which become photos in the history.
 */

// Signed requests older (or newer) than this are refused, so a captured one cannot be replayed
const MAX_CLOCK_SKEW_S = 300;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * X-CamOS-Signature is "sha256=" + hex HMAC-SHA256 of `${X-CamOS-Timestamp}.${raw body}`
 * keyed with the webhook secret (the same scheme as FlyBot's own webhooks).
 */
function verifySignature({ rawBody, timestamp, signature, secret = CAMOS_WEBHOOK_SECRET, now = Date.now() }) {
    if (!secret || !rawBody || !timestamp || !signature) return false;
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > MAX_CLOCK_SKEW_S) return false;
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
    const given = String(signature);
    return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

const labelName = (label) => (!label || isFruitFly(label)) ? FRUIT_FLY : String(label).toLowerCase();

/**
 * The camera's result in FlyBot's shape. Camera boxes are [x1, y1, x2, y2, classIndex,
 * confidence] in 0-1 of the photo; FlyBot keeps pixel boxes. `n` is the real count even when
 * the camera sent only part of the boxes (`truncated`): it counts for the photo's only label,
 * otherwise the boxes are counted per label.
 */
function toAiResults(data, { width, height }) {
    const labels = Array.isArray(data.labels) && data.labels.length ? data.labels : [data.app ? FRUIT_FLY : 'object'];
    const boxes = Array.isArray(data.boxes) ? data.boxes : [];
    const insects = boxes.map(([x1, y1, x2, y2, classIndex, confidence]) => ({
        name: labelName(labels[classIndex] ?? labels[0]),
        confidence: Number((Number(confidence) || 0).toFixed(2)),
        bbox: [Math.round(x1 * width), Math.round(y1 * height), Math.round(x2 * width), Math.round(y2 * height)]
    }));
    const count = Number.isInteger(data.n) && data.n >= 0 ? data.n : insects.length;
    let summary;
    if (new Set(labels.map(labelName)).size === 1) {
        summary = { [labelName(labels[0])]: count };
    } else {
        summary = {};
        for (const insect of insects) summary[insect.name] = (summary[insect.name] || 0) + 1;
    }
    return {
        detected: count > 0,
        insects,
        summary,
        raw_description: `Camera${data.model ? ` (${data.model})` : ''} detected ${count} object(s).`
    };
}

async function updateStatus(camera, status) {
    await Camera.updateMany({ deviceSerial: camera.deviceSerial, provider: 'camos' }, { $set: { status, lastSync: new Date() } });
    if (Number(camera.status) !== status) {
        await notificationService.cameraStatusChanged(camera.deviceSerial, status)
            .catch(err => console.error(`⚠️ Status alert failed (${camera.deviceSerial}):`, err.message));
    }
    return 'updated';
}

/**
 * A photo the camera took by itself, into the history: with the camera's count, or (a plain
 * scheduled photo, `analyze`) through FlyBot's AI like any capture. Stored once per event id.
 */
async function storePhoto(camera, event, { analyze = false } = {}) {
    const image = event.data?.image;
    if (!image?.url) return 'ignored';
    if (await Snapshot.exists({ deviceEventId: event.id })) return 'duplicate';

    const imageRes = await axios.get(image.url, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: MAX_IMAGE_BYTES });
    const buffer = Buffer.from(imageRes.data);
    const size = image.w > 0 && image.h > 0 ? { width: image.w, height: image.h } : getImageDimensions(buffer);
    const takenAt = Number.isFinite(Number(event.ts)) ? new Date(Number(event.ts)) : new Date();
    try {
        // Lazy require: captureJob pulls in the AI and S3 services
        await require('../cron/captureJob').ingestPhoto(camera.deviceSerial, buffer, {
            picUrl: image.url,
            takenAt,
            deviceEventId: event.id,
            deviceAi: analyze ? null : toAiResults(event.data, size)
        });
    } catch (err) {
        // The same event delivered again while the first delivery was being stored
        if (err.code === 11000) return 'duplicate';
        throw err;
    }
    return 'stored';
}

/**
 * Handle one event. Returns what was done ('updated', 'stored', 'duplicate', 'ignored');
 * throws when it should be delivered again (download or storage failed).
 */
async function handleEvent(event) {
    const camera = await Camera.findOne({ deviceSerial: String(event.serial || ''), provider: 'camos' }).select('deviceSerial status').lean();
    if (!camera) return 'ignored';
    switch (event.event) {
        case 'device.online':
            return updateStatus(camera, 1);
        case 'device.offline':
            return updateStatus(camera, 0);
        case 'app_detection':
        case 'person':
        case 'object':
            return storePhoto(camera, event);
        case 'capture':
            // Photos FlyBot asked for come back from its own capture call; only the camera's own schedule here
            return event.data?.trigger === 'schedule' ? storePhoto(camera, event, { analyze: true }) : 'ignored';
        default:
            return 'ignored';
    }
}

module.exports = {
    verifySignature,
    toAiResults,
    handleEvent
};
