const axios = require('axios');
const { Camera, Snapshot } = require('../models');
const { AI_PROVIDER, S3_PUBLIC_URL } = require('../config/env');
const ezvizService = require('../services/ezvizService');
const s3Service = require('../services/s3Service');
const aiService = require('../services/aiService');
const notificationService = require('../services/notificationService');

/**
 * Capture image from camera, upload to S3, and trigger AI analysis
 */
async function captureAndSaveSnapshot(deviceSerial) {
    try {
        const captureRes = await ezvizService.captureDevice(deviceSerial);

        if (captureRes.code != '200') {
            console.log(`Can't get image from device ${deviceSerial}`);
            return null;
        }

        if (captureRes.code === '200' && captureRes.data?.picUrl) {
            const picUrl = captureRes.data.picUrl;

            // 1. Download image
            const imageRes = await axios.get(picUrl, { responseType: 'arraybuffer' });
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
                    await notificationService.checkPestThreshold(deviceSerial, notificationService.countPests(analyzed.aiResults?.summary));
                }
            } catch (alertErr) {
                console.error(`⚠️ Alert check failed (${deviceSerial}):`, alertErr.message);
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

/**
 * Automatically scan and capture snapshots from all cameras
 */
async function autoCaptureAllCameras() {
    console.log("🚀 Starting automatic snapshot capture & AI recognition job...");
    try {
        // Backfill any missing camera thumbnails first
        await backfillCameraThumbnails();

        const onlineCameras = await Camera.find({});
        const deviceSerials = [];
        for (const cam of onlineCameras) {
            if (!deviceSerials.includes(cam.deviceSerial)) {
                await captureAndSaveSnapshot(cam.deviceSerial);
                deviceSerials.push(cam.deviceSerial);
            }
            await new Promise(resolve => setTimeout(resolve, 2000)); // Delay to avoid rate limit
        }
    } catch (error) {
        console.error("❌ Auto-capture error:", error.message);
    }
}

module.exports = {
    captureAndSaveSnapshot,
    autoCaptureAllCameras,
    backfillCameraThumbnails
};
