const axios = require('axios');
const { Camera, Snapshot } = require('../models');
const { S3_PUBLIC_URL, CAPTURE_CONCURRENCY } = require('../config/env');
const { runPool } = require('../utils/concurrency');
const ezvizService = require('../services/ezvizService');
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
 * Capture image from camera, upload to S3, and trigger AI analysis
 */
async function captureAndSaveSnapshot(deviceSerial) {
    try {
        // Record the attempt first, so an offline camera is retried on its normal cadence, not every tick
        await Camera.updateMany({ deviceSerial }, { $set: { lastCaptureAt: new Date() } });

        const captureRes = await ezvizService.captureDevice(deviceSerial);

        if (captureRes.code != '200') {
            console.log(`Can't get image from device ${deviceSerial}`);
            return null;
        }

        if (captureRes.code === '200' && captureRes.data?.picUrl) {
            const picUrl = captureRes.data.picUrl;

            // 1. Download image
            const imageRes = await axios.get(picUrl, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: 20 * 1024 * 1024 });
            const buffer = Buffer.from(imageRes.data, 'binary');
            const base64Image = buffer.toString('base64');

            // 2. Upload to S3
            const fileName = `${deviceSerial}_${Date.now()}.jpg`;
            const s3Key = `snapshots/${deviceSerial}/${fileName}`;

            await s3Service.uploadSnapshot(s3Key, buffer, 'image/jpeg');

            const finalUrl = `${S3_PUBLIC_URL || ''}/${s3Key}`;

            // 3. Save to Database
            const newSnapshot = new Snapshot({
                deviceSerial: deviceSerial,
                imageUrl: finalUrl,
                s3Key: s3Key
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

            // 3.1. Save thumbnail image to Camera for display across cameras and settings pages
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

            // 4. Send to AI for processing
            await aiService.analyzeSnapshot(base64Image, savedDoc._id, picUrl);

            console.log(`📸 Snapshot saved & sent to AI: ${deviceSerial}`);

            // 5. Alerts: pest threshold reached, or AI analysis failing repeatedly
            await checkAlerts(deviceSerial, savedDoc._id);

            // 6. Photo quality: dark, blurry, dirty lens or a full sticky card
            try {
                const analyzed = await Snapshot.findById(savedDoc._id).lean();
                const count = analyzed?.aiProcessed ? notificationService.countPests(analyzed.aiResults?.summary) : 0;
                await imageQuality.checkSnapshot(analyzed || savedDoc, buffer, { count });
            } catch (qualityErr) {
                console.error(`⚠️ Image quality check failed (${deviceSerial}):`, qualityErr.message);
            }

            // 7. Webhook snapshot_analyzed, once the AI result and the quality are both stored.
            // In the background, so a slow receiver does not hold up the next capture
            snapshotEvents.emitAnalyzed(savedDoc._id, { buffer });
            return savedDoc;
        }
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
        const camerasWithoutThumb = await Camera.find({
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
        const cameras = await Camera.find({}).select('deviceSerial captureIntervalMinutes captureDaytimeOnly lastCaptureAt');
        const due = dueSerials(cameras, new Date());
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
            if (!(await aiService.analyzeSnapshot(buffer.toString('base64'), snap._id))) continue;
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
    retryFailedAnalyses,
    captureAndSaveSnapshot,
    autoCaptureDueCameras,
    backfillCameraThumbnails
};
