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
 * recent good photos rather than fixed numbers.
 */
const SAMPLE_WIDTH = 320;
const DARK_BRIGHTNESS = 35;
const BRIGHT_BRIGHTNESS = 235;
const CLIPPED_SHARE = 0.35;
// Below this share of the camera's usual sharpness (edges per unit of contrast) / contrast
const BLUR_RATIO = 0.35;
const HAZE_RATIO = 0.5;
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
    else if (baseline) {
        // A hazy lens lowers edges and contrast together; blur lowers edges much more than contrast
        const edgeRatio = (q) => (q.contrast > 0 ? q.sharpness / (q.contrast * q.contrast) : 0);
        if (edgeRatio(baseline) > 0 && edgeRatio(m) < edgeRatio(baseline) * BLUR_RATIO) issues.add('blurry');
        if (baseline.contrast > 0 && m.contrast < baseline.contrast * HAZE_RATIO) issues.add('low_contrast');
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
    const sample = grayscale(buffer);
    if (!sample) return null;
    const metrics = metricsOf(sample);
    metrics.coverage = coverageOf(snapshot.aiResults?.insects, sample.imageWidth, sample.imageHeight);
    const baseline = await baselineFor(snapshot.deviceSerial);
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', hourCycle: 'h23' }).format(snapshot.createdAt || new Date()));
    const sticky = !(await Camera.exists({ deviceSerial: snapshot.deviceSerial, trapKind: 'lure' }));
    const issues = assess(metrics, baseline, count, { daylight: hour >= DAYLIGHT_HOURS[0] && hour < DAYLIGHT_HOURS[1], sticky });
    const quality = { ...metrics, issues, checkedAt: new Date() };

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
        Camera.updateMany({ deviceSerial: snapshot.deviceSerial }, { $set: { imageQuality: { issues, checkedAt: quality.checkedAt } } })
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
    coverageOf,
    assess,
    baselineFor,
    checkSnapshot
};
