const { Camera, Snapshot } = require('../models');
const { TIMEZONE } = require('./captureSchedule');
const jobStatus = require('./jobStatus');
const { AI_RETRY } = require('../cron/captureJob');

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_HOURS = 24;
// A camera whose photos fail this often in the window is listed as a problem
const FAILING_RATE = 0.2;

/**
 * Capture pipeline over the last 24 hours, for the admin monitor: photos taken and analyzed per
 * hour, the AI retry queue, each camera's photos and failures, and the background jobs' last runs.
 * A photo counts as failed once it is older than the time a capture takes to analyze it.
 */
async function pipelineOverview(now = new Date()) {
    const since = new Date(now.getTime() - WINDOW_HOURS * HOUR_MS);
    const settled = new Date(now.getTime() - AI_RETRY.minAgeMs);
    const isFailed = { $and: [{ $eq: ['$aiProcessed', false] }, { $lt: ['$createdAt', settled] }] };
    const count = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });

    const [facets] = await Snapshot.aggregate([
        { $match: { createdAt: { $gte: since, $lte: now } } },
        {
            $facet: {
                hours: [
                    { $group: {
                        _id: { $dateToString: { format: '%Y-%m-%dT%H', date: '$createdAt', timezone: TIMEZONE } },
                        photos: { $sum: 1 },
                        analyzed: count('$aiProcessed'),
                        failed: count(isFailed)
                    } }
                ],
                cameras: [
                    { $group: {
                        _id: '$deviceSerial',
                        photos: { $sum: 1 },
                        analyzed: count('$aiProcessed'),
                        failed: count(isFailed),
                        recovered: count({ $and: ['$aiProcessed', { $gte: [{ $ifNull: ['$aiRetries', 0] }, 1] }] }),
                        lastPhotoAt: { $max: '$createdAt' }
                    } }
                ]
            }
        }
    ]);

    const [waitingRetry, gaveUp] = await Promise.all([
        Snapshot.countDocuments({
            aiProcessed: false,
            createdAt: { $gte: new Date(now.getTime() - AI_RETRY.windowMs), $lte: settled },
            aiRetries: { $not: { $gte: AI_RETRY.max } }
        }),
        Snapshot.countDocuments({ aiProcessed: false, createdAt: { $gte: since, $lte: now }, aiRetries: { $gte: AI_RETRY.max } })
    ]);

    // Every hour of the window, oldest first, including hours without photos
    const byHour = new Map(facets.hours.map(h => [h._id, h]));
    const hourKey = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
    const hours = [];
    for (let i = WINDOW_HOURS - 1; i >= 0; i--) {
        const parts = Object.fromEntries(hourKey.formatToParts(new Date(now.getTime() - i * HOUR_MS)).map(p => [p.type, p.value]));
        const key = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`;
        const h = byHour.get(key);
        hours.push({ hour: key, photos: h?.photos || 0, analyzed: h?.analyzed || 0, failed: h?.failed || 0 });
    }

    const stats = new Map(facets.cameras.map(c => [c._id, c]));
    const cameraDocs = await Camera.find({ unclaimed: { $ne: true }, simulated: { $ne: true } }).select('deviceSerial deviceName status lastCaptureAt captureIntervalMinutes').lean();
    const seen = new Set();
    const cameras = [];
    for (const cam of cameraDocs) {
        if (seen.has(cam.deviceSerial)) continue;
        seen.add(cam.deviceSerial);
        const s = stats.get(cam.deviceSerial);
        const photos = s?.photos || 0;
        const failed = s?.failed || 0;
        const problems = [];
        if (!photos) problems.push('noPhotos');
        if (photos && failed / photos >= FAILING_RATE) problems.push('failing');
        cameras.push({
            deviceSerial: cam.deviceSerial,
            deviceName: cam.deviceName,
            status: cam.status,
            photos,
            analyzed: s?.analyzed || 0,
            failed,
            recovered: s?.recovered || 0,
            lastPhotoAt: s?.lastPhotoAt || null,
            lastCaptureAt: cam.lastCaptureAt || null,
            problems
        });
    }
    // Problems first, then the most failures
    cameras.sort((a, b) => b.problems.length - a.problems.length || b.failed - a.failed || a.deviceSerial.localeCompare(b.deviceSerial));

    const totals = hours.reduce((t, h) => ({
        photos: t.photos + h.photos,
        analyzed: t.analyzed + h.analyzed,
        failed: t.failed + h.failed
    }), { photos: 0, analyzed: 0, failed: 0 });

    return {
        windowHours: WINDOW_HOURS,
        generatedAt: now,
        totals: {
            ...totals,
            recovered: cameras.reduce((sum, c) => sum + c.recovered, 0),
            waitingRetry,
            gaveUp
        },
        retry: { maxAttempts: AI_RETRY.max, windowHours: AI_RETRY.windowMs / HOUR_MS },
        hours,
        cameras,
        jobs: jobStatus.list()
    };
}

module.exports = { pipelineOverview };
