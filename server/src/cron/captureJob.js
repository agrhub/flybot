const axios = require('axios');
const { Camera, Snapshot } = require('../models');
const { AI_PROVIDER, S3_PUBLIC_URL, CAPTURE_CONCURRENCY } = require('../config/env');
const { runPool } = require('../utils/concurrency');
const ezvizService = require('../services/ezvizService');
const s3Service = require('../services/s3Service');
const aiService = require('../services/aiService');
const notificationService = require('../services/notificationService');
const maintenanceService = require('../services/maintenanceService');
const { dueSerials } = require('../services/captureSchedule');
const imageQuality = require('../services/imageQuality');

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
            const savedDoc = await newSnapshot.save();

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
            if (AI_PROVIDER === 'roboflow') {
                await aiService.analyzeInsectsRoboflow(base64Image, savedDoc._id, picUrl);
            } else if (AI_PROVIDER === 'both') {
                await aiService.analyzeInsects(base64Image, savedDoc._id);
                await aiService.analyzeInsectsRoboflow(base64Image, savedDoc._id, picUrl);
            } else {
                await aiService.analyzeInsects(base64Image, savedDoc._id);
            }

            console.log(`📸 Snapshot saved & sent to AI: ${deviceSerial}`);

            // 5. Alerts: pest threshold reached, or AI analysis failing repeatedly
            try {
                const analyzed = await Snapshot.findById(savedDoc._id);
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

            // 6. Photo quality: dark, blurry, dirty lens or a full sticky card
            try {
                const analyzed = await Snapshot.findById(savedDoc._id).lean();
                const count = analyzed?.aiProcessed ? notificationService.countPests(analyzed.aiResults?.summary) : 0;
                await imageQuality.checkSnapshot(analyzed || savedDoc, buffer, { count });
            } catch (qualityErr) {
                console.error(`⚠️ Image quality check failed (${deviceSerial}):`, qualityErr.message);
            }
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
    if (captureRunInProgress) return;
    captureRunInProgress = true;
    try {
        const cameras = await Camera.find({}).select('deviceSerial captureIntervalMinutes captureDaytimeOnly lastCaptureAt');
        const due = dueSerials(cameras, new Date());
        if (due.length === 0) return;
        console.log(`🚀 Capturing ${due.length} due camera(s), ${CAPTURE_CONCURRENCY} at a time...`);
        // Several cameras in parallel (each one waits on EZVIZ, S3 and the AI), with
        // starts spaced out so EZVIZ is not hit in a burst
        const started = Date.now();
        await runPool(due, { limit: CAPTURE_CONCURRENCY, minStartGapMs: 1000 }, captureAndSaveSnapshot);
        console.log(`✅ Captured ${due.length} camera(s) in ${Math.round((Date.now() - started) / 1000)}s`);
    } catch (error) {
        console.error("❌ Auto-capture error:", error.message);
    } finally {
        captureRunInProgress = false;
    }
}

module.exports = {
    captureAndSaveSnapshot,
    autoCaptureDueCameras,
    backfillCameraThumbnails
};
