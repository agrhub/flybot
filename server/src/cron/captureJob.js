const { Camera, Snapshot } = require('../models');
const { S3_PUBLIC_URL, CAPTURE_CONCURRENCY } = require('../config/env');
const { runPool } = require('../utils/concurrency');
const platforms = require('../platforms');
const s3Service = require('../services/s3Service');
const aiService = require('../services/aiService');
const notificationService = require('../services/notificationService');
const maintenanceService = require('../services/maintenanceService');
const { dueSerials } = require('../services/captureSchedule');
const imageQuality = require('../services/imageQuality');
const snapshotEvents = require('../services/snapshotEvents');

/**
 * After a snapshot's AI analysis: pest threshold, card change, plot and surge alerts, and the
 * repeated AI failure alert. Never throws.
 */
async function checkAlerts(deviceSerial, snapshotId) {
    try {
        const analyzed = await Snapshot.findById(snapshotId);
        const succeeded = !!analyzed?.aiProcessed;
        await notificationService.recordAiResult(deviceSerial, succeeded);
        if (succeeded) {
            const count = notificationService.countPests(analyzed.aiResults?.summary);
            await notificationService.checkPestThreshold(deviceSerial, count);
            await maintenanceService.detectCardChange(deviceSerial, analyzed, count);
            await require('../services/farmService').checkPlotThreshold(deviceSerial);
            await require('../services/surgeService').checkSurge(deviceSerial);
        }
    } catch (alertErr) {
        console.error(`⚠️ Alert check failed (${deviceSerial}):`, alertErr.message);
    }
}

/**
 * Store one photo of a camera: upload to S3, the Snapshot row, the camera thumbnail. Returns the
 * saved document. `trigger`: 'sentinel' (an extra photo FlyBot Sentinel asked for; the camera's
 * schedule is not moved), or what a CamOS camera said ('schedule' | 'rpc' | 'boot'); `meta`:
 * what the camera sent with the photo; `capturedAt`: when it was taken (default now).
 */
async function storeSnapshot(deviceSerial, buffer, { trigger, meta, capturedAt } = {}) {
    const fileName = `${deviceSerial}_${Date.now()}.jpg`;
    const s3Key = `snapshots/${deviceSerial}/${fileName}`;

    await s3Service.uploadSnapshot(s3Key, buffer, 'image/jpeg');

    const finalUrl = `${S3_PUBLIC_URL || ''}/${s3Key}`;

    const newSnapshot = new Snapshot({
        deviceSerial: deviceSerial,
        imageUrl: finalUrl,
        s3Key: s3Key,
        ...(trigger ? { trigger } : {}),
        ...(meta ? { meta } : {}),
        ...(capturedAt instanceof Date && !isNaN(capturedAt) ? { createdAt: capturedAt } : {})
    });
    let savedDoc;
    try {
        savedDoc = await newSnapshot.save();
    } catch (saveErr) {
        // Nothing would point to the file: remove it rather than leave it in the bucket
        await s3Service.deleteS3Object(s3Key).catch((delErr) => {
            console.warn(`⚠️ Could not remove unsaved photo ${s3Key}:`, delErr.message);
        });
        throw saveErr;
    }

    // Save thumbnail image to Camera for display across cameras and settings pages
    try {
        await Camera.updateMany(
            { deviceSerial: deviceSerial },
            {
                $set: {
                    thumbnailUrl: finalUrl,
                    picUrl: finalUrl,
                    lastSync: new Date()
                }
            }
        );
        console.log(`🖼️ Updated camera thumbnail for ${deviceSerial}: ${finalUrl}`);
    } catch (camErr) {
        console.warn(`⚠️ Failed to update camera thumbnail for ${deviceSerial}:`, camErr.message);
    }
    return savedDoc;
}

/**
 * After a photo is stored: the AI analysis, the alerts, the quality check and the
 * snapshot_analyzed webhook. `picUrl`: a link the Roboflow provider can fetch the photo from.
 * With AI_PROVIDER=sentinel no cloud model runs here: the photo waits for
 * POST /api/sentinel/analysis, and its alerts run then. Never throws.
 */
async function finishSnapshot(savedDoc, buffer, { picUrl = null } = {}) {
    const deviceSerial = savedDoc.deviceSerial;
    // A photo of a self-registered camera nobody claimed yet: analyzed (rule planner), but it
    // alerts nobody, gets no quality notice and no webhook (CONTRACTS 2a.3)
    if (savedDoc.unclaimed === true) {
        try {
            await aiService.analyzeSnapshot(buffer.toString('base64'), savedDoc._id, picUrl, { buffer });
        } catch (error) {
            console.error(`❌ Unclaimed photo analysis failed (${deviceSerial}):`, error.message);
        }
        return savedDoc;
    }
    try {
        const awaitSentinel = aiService.isSentinelMode();
        if (!awaitSentinel) {
            // 4. Send to AI for processing
            await aiService.analyzeSnapshot(buffer.toString('base64'), savedDoc._id, picUrl, { buffer });

            console.log(`📸 Snapshot saved & sent to AI: ${deviceSerial}`);

            // 5. Alerts: pest threshold reached, or AI analysis failing repeatedly
            await checkAlerts(deviceSerial, savedDoc._id);
        } else {
            console.log(`📸 Snapshot saved, waiting for the Sentinel analysis: ${deviceSerial}`);
        }

        // 6. Photo quality: dark, blurry, dirty lens or a full sticky card
        try {
            const analyzed = await Snapshot.findById(savedDoc._id).lean();
            const count = analyzed?.aiProcessed ? notificationService.countPests(analyzed.aiResults?.summary) : 0;
            await imageQuality.checkSnapshot(analyzed || savedDoc, buffer, { count });
        } catch (qualityErr) {
            console.error(`⚠️ Image quality check failed (${deviceSerial}):`, qualityErr.message);
        }

        // 7. Webhook snapshot_analyzed, once the AI result and the quality are both stored
        // (AI_PROVIDER=sentinel: once the quality is stored, with aiSource "pending").
        // In the background, so a slow receiver does not hold up the next capture
        snapshotEvents.emitAnalyzed(savedDoc._id, { buffer, pending: awaitSentinel });
    } catch (error) {
        console.error(`❌ Snapshot processing error (${deviceSerial}):`, error.message);
    }
    return savedDoc;
}

/**
 * Capture image from camera (through its platform adapter), upload to S3, and trigger AI analysis.
 * trigger 'sentinel': an extra photo FlyBot Sentinel asked for; it is marked on the snapshot and
 * does not move the camera's schedule (lastCaptureAt).
 * A CamOS camera uploads the photo itself (device API): its adapter answers with the stored
 * snapshot, which is returned as is.
 */
async function captureAndSaveSnapshot(deviceSerial, { trigger } = {}) {
    try {
        // Record the attempt first, so an offline camera is retried on its normal cadence, not every tick
        // A camera an admin paused takes no photo (cron, "Capture now", Sentinel)
        if (await require('../services/fleetService').serialDisabled(deviceSerial)) return null;
        if (trigger !== 'sentinel') await Camera.updateMany({ deviceSerial }, { $set: { lastCaptureAt: new Date() } });

        const platform = await platforms.forSerial(deviceSerial);
        const shot = await platform.snapshot(deviceSerial);
        if (!shot) return null;
        if (shot.snapshot) return shot.snapshot;

        const buffer = shot.buffer;
        const savedDoc = await storeSnapshot(deviceSerial, buffer, { trigger });
        return await finishSnapshot(savedDoc, buffer, { picUrl: shot.picUrl || null });
    } catch (error) {
        console.error(`❌ Snapshot error (${deviceSerial}):`, error.message);
    }
    return null;
}

/**
 * Backfill missing camera thumbnails from the latest snapshot in database
 */
async function backfillCameraThumbnails() {
    try {
        // Simulated demo cameras have no device to ask
        const camerasWithoutThumb = await Camera.find({
            simulated: { $ne: true },
            $or: [
                { thumbnailUrl: { $in: ['', null] } },
                { picUrl: { $in: ['', null] } }
            ]
        });

        for (const cam of camerasWithoutThumb) {
            const latestSnap = await Snapshot.findOne({ deviceSerial: cam.deviceSerial }).sort({ createdAt: -1 });
            if (latestSnap && (latestSnap.imageUrl || latestSnap.s3Key)) {
                const thumbUrl = latestSnap.imageUrl || latestSnap.s3Key;
                await Camera.updateOne(
                    { _id: cam._id },
                    {
                        $set: {
                            thumbnailUrl: thumbUrl,
                            picUrl: cam.picUrl && cam.picUrl.trim() !== '' ? cam.picUrl : thumbUrl
                        }
                    }
                );
                console.log(`🖼️ Backfilled thumbnail for camera ${cam.deviceSerial}: ${thumbUrl}`);
            }
        }
    } catch (error) {
        console.warn('⚠️ Could not backfill camera thumbnails:', error.message);
    }
}

let captureRunInProgress = false;

/**
 * Capture every device whose schedule says it is due (see services/captureSchedule.js).
 * Runs on a short tick; a run is skipped if the previous one is still going.
 */
async function autoCaptureDueCameras() {
    if (captureRunInProgress) return null;
    captureRunInProgress = true;
    try {
        // CamOS cameras take their photos by their own schedule (shadow capture.intervalMin) and
        // upload them to the device API: only EZVIZ cameras are polled here
        const cameras = await Camera.find({ $or: [{ platform: 'ezviz' }, { platform: { $exists: false } }], 'adminDisabled.at': { $exists: false } })
            .select('deviceSerial captureIntervalMinutes captureDaytimeOnly lastCaptureAt sentinelInterval');
        let due = dueSerials(cameras, new Date());
        // Each workspace plan allows so many photos per camera a day (services/entitlements.js)
        if (due.length) {
            const over = await require('../services/entitlements').overDailyLimit(due).catch(() => new Set());
            if (over.size) due = due.filter(serial => !over.has(serial));
        }
        if (due.length === 0) return { cameras: 0, saved: 0 };
        console.log(`🚀 Capturing ${due.length} due camera(s), ${CAPTURE_CONCURRENCY} at a time...`);
        // Several cameras in parallel (each one waits on EZVIZ, S3 and the AI), with
        // starts spaced out so EZVIZ is not hit in a burst
        const started = Date.now();
        let saved = 0;
        await runPool(due, { limit: CAPTURE_CONCURRENCY, minStartGapMs: 1000 }, async (serial) => {
            if (await captureAndSaveSnapshot(serial)) saved++;
        });
        console.log(`✅ Captured ${due.length} camera(s) in ${Math.round((Date.now() - started) / 1000)}s`);
        return { cameras: due.length, saved };
    } catch (error) {
        console.error("❌ Auto-capture error:", error.message);
        throw error;
    } finally {
        captureRunInProgress = false;
    }
}

const AI_RETRY = {
    // Photos whose AI analysis failed at capture are tried again for a while
    windowMs: 6 * 60 * 60 * 1000,
    // Not before this, so a capture still analyzing its photo is left alone
    minAgeMs: 10 * 60 * 1000,
    max: 3,
    batch: 20
};

/**
 * Analyze again the recent photos the AI failed on (image read back from S3), oldest first.
 * Alerts run only for a photo that is still its camera's latest: an older one would raise a
 * stale alert. Returns { retried, succeeded }.
 */
async function retryFailedAnalyses(now = new Date()) {
    // AI_PROVIDER=sentinel: no cloud model to retry; the photos wait for Sentinel
    if (aiService.isSentinelMode()) return { retried: 0, succeeded: 0 };
    const due = await Snapshot.find({
        aiProcessed: false,
        createdAt: { $gte: new Date(now.getTime() - AI_RETRY.windowMs), $lte: new Date(now.getTime() - AI_RETRY.minAgeMs) },
        aiRetries: { $not: { $gte: AI_RETRY.max } }
    }).sort({ createdAt: 1 }).limit(AI_RETRY.batch).select('_id deviceSerial s3Key createdAt aiRetries').lean();

    const result = { retried: 0, succeeded: 0 };
    for (const snap of due) {
        // Claimed first: the attempt counts even if this run stops half way
        const claimed = await Snapshot.updateOne(
            { _id: snap._id, aiProcessed: false, aiRetries: snap.aiRetries ?? { $exists: false } },
            { $inc: { aiRetries: 1 } }
        );
        if (!claimed.modifiedCount) continue;
        result.retried++;
        try {
            const buffer = await s3Service.readS3Buffer(snap.s3Key);
            if (!(await aiService.analyzeSnapshot(buffer.toString('base64'), snap._id, null, { buffer }))) continue;
            result.succeeded++;
            const newer = await Snapshot.exists({ deviceSerial: snap.deviceSerial, createdAt: { $gt: snap.createdAt } });
            if (!newer) await checkAlerts(snap.deviceSerial, snap._id);
            // Its quality was measured at capture; now it has the AI result too (any photo, not only the latest)
            snapshotEvents.emitAnalyzed(snap._id, { buffer });
        } catch (err) {
            console.error(`❌ AI retry failed (${snap.deviceSerial}, ${snap._id}):`, err.message);
        }
    }
    if (result.retried) console.log(`🔁 AI analysis retried on ${result.retried} photo(s), ${result.succeeded} succeeded.`);
    return result;
}

module.exports = {
    AI_RETRY,
    checkAlerts,
    retryFailedAnalyses,
    storeSnapshot,
    finishSnapshot,
    captureAndSaveSnapshot,
    autoCaptureDueCameras,
    backfillCameraThumbnails
};
