const jpeg = require('jpeg-js');
const { Camera, Snapshot } = require('../models');
const { TIMEZONE } = require('./captureSchedule');

/**
 * Image quality of each snapshot, so a bad picture is caught before its AI count is trusted.
 *
 * Measured on a small grayscale copy of the photo:
 * - brightness: mean luminance (0-255)
 * - contrast: standard deviation of luminance
 * - sharpness: variance of the Laplacian (edges); blur flattens it
 * - clipped: share of pure-white pixels
 * Blur and haze depend a lot on the scene, so they are judged against the camera's own
 * recent good photos rather than fixed numbers; a camera whose every photo is out of focus
 * would set its own baseline, so very low edges per unit of contrast are blurry whatever the baseline.
 * CamOS 0.9.0+ sends these measurements with the photo (meta.quality, computed on the camera the same way), so its
 * photos are not decoded here; every photo also gets `change`, how much it differs from the camera's previous one.
 */
const SAMPLE_WIDTH = 320;
const DARK_BRIGHTNESS = 35;
const BRIGHT_BRIGHTNESS = 235;
const CLIPPED_SHARE = 0.35;
// Below this share of the camera's usual sharpness (edges per unit of contrast) / contrast
const BLUR_RATIO = 0.35;
const HAZE_RATIO = 0.5;
// Sharpness / contrast² below this is blurry for any camera (focused traps measure 0.19 and up, an
// out-of-focus OV5640 about 0.01), once the photo has enough contrast for the ratio to mean something
const BLUR_FLOOR = 0.04;
const BLUR_FLOOR_MIN_CONTRAST = 10;
// Good photos used as the camera's reference, and how many are needed first
const BASELINE_SIZE = 20;
const BASELINE_MIN = 5;
// The sticky card is "full" when insects cover this share of the photo, or above this count
const FULL_COVERAGE = 0.25;
const FULL_COUNT = 300;

// Photos are decoded on the main thread: skip unusually large ones
const MAX_JPEG_BYTES = 6 * 1024 * 1024;
// Only recent photos count for the baseline and the "same problem twice" check
const RECENT_DAYS = 14;
// Darkness is only a problem in daylight (cameras without night vision are dark at night)
const DAYLIGHT_HOURS = [7, 17];

// Most serious first: only the first is alerted on
const ISSUES = ['dark', 'overexposed', 'blurry', 'low_contrast', 'card_full'];

/**
 * Grayscale samples of a JPEG, box-averaged down to about SAMPLE_WIDTH wide.
 * Returns { width, height, gray, imageWidth, imageHeight } or null if it cannot be decoded.
 */
function grayscale(buffer) {
    if (!buffer || buffer.length > MAX_JPEG_BYTES) return null;
    let image;
    try {
        image = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 16, maxMemoryUsageInMB: 160 });
    } catch {
        return null;
    }
    const { width: w, height: h, data } = image;
    if (!w || !h) return null;
    const step = Math.max(1, Math.floor(w / SAMPLE_WIDTH));
    const width = Math.floor(w / step);
    const height = Math.floor(h / step);
    const gray = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let sum = 0;
            for (let dy = 0; dy < step; dy++) {
                let i = ((y * step + dy) * w + x * step) * 4;
                for (let dx = 0; dx < step; dx++, i += 4) {
                    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
                }
            }
            gray[y * width + x] = sum / (step * step);
        }
    }
    return { width, height, gray, imageWidth: w, imageHeight: h };
}

/** Brightness, contrast, sharpness and clipping of a grayscale sample. */
function metricsOf({ width, height, gray }) {
    const n = gray.length;
    let sum = 0;
    let clipped = 0;
    for (let i = 0; i < n; i++) {
        sum += gray[i];
        if (gray[i] >= 250) clipped++;
    }
    const mean = sum / n;
    let variance = 0;
    for (let i = 0; i < n; i++) variance += (gray[i] - mean) ** 2;

    let lapSum = 0;
    let lapSq = 0;
    let lapCount = 0;
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            const lap = gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i];
            lapSum += lap;
            lapSq += lap * lap;
            lapCount++;
        }
    }
    const lapMean = lapCount ? lapSum / lapCount : 0;
    const round1 = (v) => Math.round(v * 10) / 10;
    return {
        brightness: round1(mean),
        contrast: round1(Math.sqrt(variance / n)),
        sharpness: round1(lapCount ? lapSq / lapCount - lapMean ** 2 : 0),
        clipped: Math.round((clipped / n) * 1000) / 1000
    };
}

// How much a photo changed from the camera's previous one: a THUMB_W x THUMB_H grey thumbnail, cells that moved
// more than CHANGE_LEVEL once the overall brightness shift is taken out, per mille (same as camos-esp32-trap quality.c)
const THUMB_W = 40;
const THUMB_H = 30;
const CHANGE_LEVEL = 16;

/** The THUMB_W x THUMB_H box average of a grayscale sample, as bytes. */
function thumbnailOf({ width, height, gray }) {
    const thumb = new Uint8Array(THUMB_W * THUMB_H);
    for (let ty = 0; ty < THUMB_H; ty++) {
        const y0 = Math.floor((ty * height) / THUMB_H);
        const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / THUMB_H));
        for (let tx = 0; tx < THUMB_W; tx++) {
            const x0 = Math.floor((tx * width) / THUMB_W);
            const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / THUMB_W));
            let sum = 0;
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += gray[y * width + x];
            thumb[ty * THUMB_W + tx] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
        }
    }
    return thumb;
}

/** Per mille (0-1000) of the thumbnail's cells that changed from `previous`; null without a previous one. */
function changeOf(thumb, previous) {
    if (!previous || previous.length !== thumb.length) return null;
    let shift = 0;
    for (let i = 0; i < thumb.length; i++) shift += thumb[i] - previous[i];
    shift /= thumb.length;
    let changed = 0;
    for (let i = 0; i < thumb.length; i++) if (Math.abs(thumb[i] - previous[i] - shift) > CHANGE_LEVEL) changed++;
    return Math.round((changed * 1000) / thumb.length);
}

/** Width and height from a JPEG's frame header, without decoding it; null if not found. */
function jpegSize(buffer) {
    if (!buffer || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < buffer.length) {
        if (buffer[i] !== 0xff) return null;
        const marker = buffer[i + 1];
        const length = buffer.readUInt16BE(i + 2);
        // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC)
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5) };
        }
        i += 2 + length;
    }
    return null;
}

/** The camera's own measurements (meta.quality of CamOS 0.9.0+), in the stored form; null when it sent none. */
function cameraMetrics(q) {
    if (!q || ![q.brightness, q.contrast, q.sharpness, q.clipped].every(Number.isFinite)) return null;
    const round1 = (v) => Math.round(v * 10) / 10;
    return { brightness: round1(q.brightness), contrast: round1(q.contrast), sharpness: round1(q.sharpness), clipped: Math.round(q.clipped * 1000) / 1000 };
}

/** Share of the photo covered by detection boxes (pixel [xmin, ymin, xmax, ymax]); null if unknown. */
function coverageOf(insects, imageWidth, imageHeight) {
    if (!imageWidth || !imageHeight || !Array.isArray(insects) || !insects.length) return insects?.length === 0 ? 0 : null;
    let area = 0;
    for (const insect of insects) {
        const b = insect.bbox;
        if (!Array.isArray(b) || b.length !== 4) return null;
        // Boxes outside the photo mean another coordinate system: do not guess
        if (b[2] > imageWidth * 1.05 || b[3] > imageHeight * 1.05) return null;
        area += Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    }
    return Math.min(1, Math.round((area / (imageWidth * imageHeight)) * 1000) / 1000);
}

const median = (values) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};

/** The camera's usual sharpness and contrast, from its recent photos without issues. */
async function baselineFor(deviceSerial) {
    const since = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);
    const recent = await Snapshot.find({ deviceSerial, createdAt: { $gte: since }, 'quality.issues': { $size: 0 } })
        .sort({ createdAt: -1 })
        .limit(BASELINE_SIZE)
        .select('quality.sharpness quality.contrast')
        .lean();
    if (recent.length < BASELINE_MIN) return null;
    return {
        sharpness: median(recent.map(s => s.quality.sharpness)),
        contrast: median(recent.map(s => s.quality.contrast)),
        size: recent.length
    };
}

/**
 * Issues of one photo, most serious first.
 * @param {{ brightness, contrast, sharpness, clipped, coverage }} m
 * @param {{ sharpness, contrast } | null} baseline
 * @param {number} count  insects counted by the AI
 */
function assess(m, baseline, count = 0, { daylight = true, sticky = true } = {}) {
    const issues = new Set();
    if (m.brightness < DARK_BRIGHTNESS) {
        if (daylight) issues.add('dark');
    } else if (m.brightness > BRIGHT_BRIGHTNESS || m.clipped > CLIPPED_SHARE) issues.add('overexposed');
    else {
        // A hazy lens lowers edges and contrast together; blur lowers edges much more than contrast
        const edgeRatio = (q) => (q.contrast > 0 ? q.sharpness / (q.contrast * q.contrast) : 0);
        if (m.contrast >= BLUR_FLOOR_MIN_CONTRAST && edgeRatio(m) < BLUR_FLOOR) issues.add('blurry');
        if (baseline) {
            if (edgeRatio(baseline) > 0 && edgeRatio(m) < edgeRatio(baseline) * BLUR_RATIO) issues.add('blurry');
            if (baseline.contrast > 0 && m.contrast < baseline.contrast * HAZE_RATIO) issues.add('low_contrast');
        }
    }
    // Only a glue card fills up
    if (sticky && ((m.coverage !== null && m.coverage !== undefined && m.coverage >= FULL_COVERAGE) || count >= FULL_COUNT)) issues.add('card_full');
    return ISSUES.filter(issue => issues.has(issue));
}

/**
 * Measure a snapshot's photo, store the result on the snapshot and its camera, and alert the
 * people watching the camera when the same problem shows up twice in a row.
 * Returns the stored quality, or null if the photo could not be read.
 */
async function checkSnapshot(snapshot, buffer, { count = 0 } = {}) {
    const camera = await Camera.findOne({ deviceSerial: snapshot.deviceSerial }).select('trapKind +qualityThumb').lean();
    // A CamOS camera (0.9.0+) measured its own photo with these formulas: no decode here. Any other camera
    // (EZVIZ, older CamOS) is measured here, with the change from its previous photo's thumbnail.
    let metrics = cameraMetrics(snapshot.meta?.quality);
    let size;
    let change = null;
    let thumb = null;
    if (metrics) {
        size = jpegSize(buffer);
        if (Number.isInteger(snapshot.meta.quality.change)) change = snapshot.meta.quality.change;
    } else {
        const sample = grayscale(buffer);
        if (!sample) return null;
        metrics = metricsOf(sample);
        size = { width: sample.imageWidth, height: sample.imageHeight };
        thumb = thumbnailOf(sample);
        change = changeOf(thumb, camera?.qualityThumb ? Buffer.from(camera.qualityThumb, 'base64') : null);
    }
    metrics.coverage = coverageOf(snapshot.aiResults?.insects, size?.width, size?.height);
    const baseline = await baselineFor(snapshot.deviceSerial);
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', hourCycle: 'h23' }).format(snapshot.createdAt || new Date()));
    const sticky = camera?.trapKind !== 'lure';
    const issues = assess(metrics, baseline, count, { daylight: hour >= DAYLIGHT_HOURS[0] && hour < DAYLIGHT_HOURS[1], sticky });
    const quality = { ...metrics, ...(change !== null ? { change } : {}), source: thumb ? 'server' : 'camera', issues, checkedAt: new Date() };

    const previous = await Snapshot.findOne({
        deviceSerial: snapshot.deviceSerial,
        _id: { $ne: snapshot._id },
        createdAt: { $gte: new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000) },
        'quality.checkedAt': { $exists: true }
    })
        .sort({ createdAt: -1 })
        .select('quality.issues')
        .lean();
    await Promise.all([
        Snapshot.updateOne({ _id: snapshot._id }, { $set: { quality } }),
        Camera.updateMany({ deviceSerial: snapshot.deviceSerial }, {
            $set: { imageQuality: { issues, checkedAt: quality.checkedAt }, ...(thumb ? { qualityThumb: Buffer.from(thumb).toString('base64') } : {}) }
        })
    ]);

    // One bad photo can be a passing shadow or a bird: alert when it repeats
    const repeated = issues.find(issue => previous?.quality?.issues?.includes(issue));
    if (repeated) {
        const notificationService = require('./notificationService');
        await notificationService.notifyCameraOwners(snapshot.deviceSerial, 'image_quality', (camera) => ({
            deviceName: camera.deviceName || snapshot.deviceSerial,
            issue: repeated
        }));
    }
    return quality;
}

module.exports = {
    ISSUES,
    grayscale,
    metricsOf,
    thumbnailOf,
    changeOf,
    jpegSize,
    cameraMetrics,
    coverageOf,
    assess,
    baselineFor,
    checkSnapshot
};
