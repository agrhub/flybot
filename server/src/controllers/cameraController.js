const { Camera, Snapshot } = require('../models');
const { CAPTURE_INTERVALS } = require('../services/captureSchedule');
const { countPests } = require('../services/notificationService');
const ezvizService = require('../services/ezvizService');
const { sendServerError } = require('../utils/http');

// Each viewer's own active stream id per camera ("userId:serial" -> urlId), so switching
// streams only closes that viewer's previous stream, never someone else's
const activeStreamSessions = new Map();
const sessionKey = (userId, deviceSerial) => `${userId}:${deviceSerial}`;

/**
 * Close the caller's previous stream for this camera, if we know it.
 * Never calls EZVIZ without a urlId: that would disable every stream of the device.
 */
async function closePreviousStream(userId, deviceSerial, body) {
    const key = sessionKey(userId, deviceSerial);
    const urlId = body.urlId || body.id || activeStreamSessions.get(key) || '';
    activeStreamSessions.delete(key);
    if (!urlId) return null;
    return ezvizService.disableLiveAddress({ deviceSerial, urlId, channelNo: body.channelNo || 1 });
}

/**
 * Get User Camera List
 */
async function getUserCameras(req, res) {
    try {
        const userId = req.user.id;
        const page = parseInt(req.query.page) || null;
        const limit = parseInt(req.query.limit) || null;

        if (page && limit) {
            const skip = (page - 1) * limit;
            const total = await Camera.countDocuments({ userId });
            const cameras = await Camera.find({ userId }).sort({ addedAt: -1 }).skip(skip).limit(limit);
            return res.json({
                success: true,
                cameras,
                pagination: {
                    total,
                    page,
                    limit,
                    totalPages: Math.ceil(total / limit)
                }
            });
        }

        const cameras = await Camera.find({ userId }).sort({ addedAt: -1 });
        res.json({ success: true, cameras, total: cameras.length });
    } catch (error) {
        sendServerError(res, error);
    }
}

/**
 * Add new Camera for User
 */
async function addCamera(req, res) {
    try {
        const userId = req.user.id;
        const { deviceSerial, validateCode, deviceName: customName } = req.body;
        if (!deviceSerial || !validateCode) {
            return res.status(400).json({ success: false, message: "Missing deviceSerial or validateCode." });
        }

        // Check if user already added this camera - if so, update verification code
        const existing = await Camera.findOne({ userId, deviceSerial });
        if (existing) {
            existing.validateCode = validateCode.trim();
            if (customName) existing.deviceName = customName.trim();
            await existing.save();
            // Already added: just refresh the code/name (a success, not a client error)
            return res.json({ success: true, message: "Device information updated successfully.", camera: existing });
        }

        // Call EZVIZ API to bind device to APP account
        // check device in ezviz or not
        let deviceInfo = await ezvizService.getDeviceInfo(deviceSerial);
        console.log("deviceInfo", JSON.stringify(deviceInfo));
        if (!deviceInfo) {
            deviceInfo = await ezvizService.addCameraToEzviz(deviceSerial, validateCode);

            // Code 200 is success, 20017 is device already added to account (still valid for DB)
            if (deviceInfo.code !== '200' && deviceInfo.code !== '20017') {
                return res.status(400).json({
                    success: false,
                    message: "EZVIZ Error: " + (deviceInfo.msg || "Could not add device.")
                });
            }
        }
        else{
            //verify validate code
            const liveInfo = await ezvizService.getLiveAddress({deviceSerial, code: validateCode, protocol: 1});
            console.log("liveInfo", JSON.stringify(liveInfo));
            if (!liveInfo?.responseData?.data?.url) {
                return res.status(400).json({
                    success: false,
                    message: "EZVIZ Error: " + (liveInfo.responseData.msg || "Could not add device.")
                });
            }
        }

        let deviceName = customName || ("Camera " + deviceSerial);
        let status = 0;

        if (!customName && deviceInfo && deviceInfo.data && deviceInfo.data.deviceName) {
            deviceName = deviceInfo.data.deviceName;
        }

        const newCamera = new Camera({
            userId,
            deviceSerial,
            validateCode: validateCode.trim(),
            deviceName: deviceName.trim(),
            status
        });

        await newCamera.save();
        res.json({ success: true, message: "Camera added successfully.", camera: newCamera });

        // Asynchronously sync camera details in the background
        ezvizService.syncCameraStatus(deviceSerial);
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ success: false, message: "This device has already been added to the system." });
        }
        sendServerError(res, error);
    }
}

/**
 * Delete camera
 */
async function deleteCamera(req, res) {
    const userId = req.user.id;
    const { deviceSerial } = req.body;
    if (!deviceSerial) return res.status(400).json({ success: false, message: "Missing deviceSerial." });
    try {
        const deleted = await Camera.findOneAndDelete({ userId, deviceSerial });
        if (!deleted) {
            return res.status(404).json({ success: false, message: "Device not found or permission denied." });
        }
        res.json({ success: true, message: "Device removed successfully." });
    } catch (err) {
        sendServerError(res, err);
    }
}

/**
 * Edit camera (device name, validate code)
 */
async function updateCamera(req, res) {
    const userId = req.user.id;
    const { deviceSerial, deviceName, validateCode, alertThreshold, captureIntervalMinutes, captureDaytimeOnly } = req.body;
    if (!deviceSerial) return res.status(400).json({ success: false, message: "Missing deviceSerial." });
    if (typeof alertThreshold !== 'undefined' &&
        (!Number.isInteger(alertThreshold) || alertThreshold < 1 || alertThreshold > 10000)) {
        return res.status(400).json({ success: false, message: "alertThreshold must be a whole number from 1 to 10000." });
    }
    if (typeof captureIntervalMinutes !== 'undefined' && !CAPTURE_INTERVALS.includes(captureIntervalMinutes)) {
        return res.status(400).json({ success: false, message: `captureIntervalMinutes must be one of ${CAPTURE_INTERVALS.join(', ')}.` });
    }
    if (typeof captureDaytimeOnly !== 'undefined' && typeof captureDaytimeOnly !== 'boolean') {
        return res.status(400).json({ success: false, message: "captureDaytimeOnly must be true or false." });
    }
    try {
        const camera = await Camera.findOne({ userId, deviceSerial });
        if (!camera) {
            return res.status(404).json({ success: false, message: "Device not found or permission denied." });
        }
        if (typeof deviceName !== 'undefined') {
            camera.deviceName = deviceName.trim();
        }
        if (typeof validateCode !== 'undefined') {
            camera.validateCode = validateCode.trim();
        }
        if (typeof alertThreshold !== 'undefined') {
            camera.alertThreshold = alertThreshold;
        }
        if (typeof captureIntervalMinutes !== 'undefined') {
            camera.captureIntervalMinutes = captureIntervalMinutes;
        }
        if (typeof captureDaytimeOnly !== 'undefined') {
            camera.captureDaytimeOnly = captureDaytimeOnly;
        }
        await camera.save();
        res.json({ success: true, message: "Camera updated successfully.", camera });
    } catch (err) {
        sendServerError(res, err);
    }
}

/**
 * Update Camera GPS Location and Orchard Plot Address
 */
async function updateCameraLocation(req, res) {
    const userId = req.user.id;
    const { deviceSerial, latitude, longitude, locationAddress, trapType, cropType } = req.body;
    if (!deviceSerial) {
        return res.status(400).json({ success: false, message: "Missing deviceSerial." });
    }

    try {
        const camera = await Camera.findOne({ userId, deviceSerial });
        if (!camera) {
            return res.status(404).json({ success: false, message: "Camera not found or permission denied." });
        }

        if (latitude !== undefined) camera.latitude = Number(latitude);
        if (longitude !== undefined) camera.longitude = Number(longitude);
        if (locationAddress !== undefined) camera.locationAddress = locationAddress;
        if (trapType !== undefined) camera.trapType = trapType;
        if (cropType !== undefined) camera.cropType = cropType;

        await camera.save();
        res.json({ success: true, message: "Camera location updated successfully.", camera });
    } catch (err) {
        sendServerError(res, err);
    }
}

/**
 * Update Verification Code for Camera
 */
async function updateCameraCode(req, res) {
    const userId = req.user.id;
    const { deviceSerial, validateCode } = req.body;
    if (!deviceSerial || !validateCode) {
        return res.status(400).json({ success: false, message: "Missing deviceSerial or validateCode." });
    }
    try {
        const cleanCode = validateCode.trim();
        const camera = await Camera.findOne({ userId, deviceSerial });
        if (!camera) {
            return res.status(404).json({ success: false, message: "Device not found or permission denied." });
        }
        camera.validateCode = cleanCode;
        await camera.save();
        res.json({ success: true, message: "Verification code updated successfully.", camera });
    } catch (err) {
        sendServerError(res, err);
    }
}

/**
 * Get live stream link (EZOPEN / HLS)
 */
async function getLiveStream(req, res) {
    const userId = req.user.id;
    const { deviceSerial } = req.body;
    if (!deviceSerial) return res.status(400).json({ code: "400", msg: "Missing Serial Number." });

    try {
        const camera = await Camera.findOne({ userId, deviceSerial });
        if (!camera) {
            return res.status(403).json({ code: "403", msg: "You do not have permission to access this camera." });
        }

        let code = (camera.validateCode || '').trim();
        // check camera setting first

        // Invalidate / disable old active stream using urlId from client or server cache
        await closePreviousStream(userId, deviceSerial, req.body);

        const isEncrypt = (camera.isEncrypt === 1);
        console.log("isEncrypt: ", isEncrypt);
        // Protocol 1: ezopen (standard for multi-camera playback), Protocol 2: HLS
        const reqProtocol = req.body.protocol || req.query.protocol;
        const protocol = isEncrypt ? 1 : 2;
        // For ezopen, use quality 1 (HD)
        const streamQuality = protocol === 2 ? 1 : (Number(req.body.quality) === 2 ? 2 : 1);
        console.log("protocol:", protocol, "streamQuality:", streamQuality);
        let responseData, token, areaDomain;
        let result = await ezvizService.getLiveAddress({
            deviceSerial,
            code,
            protocol: protocol,
            quality: streamQuality,
        });
        console.log("result1: ", JSON.stringify(result));

        if (result && result.responseData) {
            responseData = result.responseData;
            token = result.token;
            areaDomain = result.areaDomain;
        }

        console.log("response live: ", JSON.stringify(responseData));

        if (responseData && responseData.code == '60019') {
            await Camera.updateMany({ deviceSerial }, { $set: { isEncrypt: 1 } });
            result = await ezvizService.getLiveAddress({
                deviceSerial,
                code,
                protocol: 1, // 1: ezopen
                quality: 1, // Use 1 (HD) for ezopen
            });

            if (!result) {
                return res.status(500).json({ code: "500", msg: "EZVIZ API error" });
            }
            responseData = result.responseData;
            token = result.token;
            areaDomain = result.areaDomain;
        }

        if (!responseData) {
            return res.status(500).json({ code: "500", msg: "EZVIZ API error" });
        }

        if (responseData.code == '200') {
            const liveUrl = responseData.data?.url || '';
            const isEncrypted = liveUrl.includes('@') ? 1 : 0;

            await Camera.updateMany({ deviceSerial }, { $set: { isEncrypt: isEncrypted } });

            if (responseData.data?.id) {
                activeStreamSessions.set(sessionKey(userId, deviceSerial), responseData.data.id);
            }

            responseData.data.accessToken = token;
            responseData.data.areaDomain = areaDomain;
            responseData.data.isEncrypt = isEncrypted;
            responseData.data.validateCode = isEncrypted ? code : '';
        } else if (responseData.code == '60019') {
            return res.json({
                code: "60019",
                msg: "Camera video encryption is enabled. Please enter verification code to decrypt.",
                data: {
                    isEncrypt: 1,
                    deviceSerial: deviceSerial
                }
            });
        }

        res.json(responseData);
    } catch (error) {
        console.log(error);
        sendServerError(res, error, { format: 'ezviz' });
    }
}

/**
 * Get video playback record list (API v3 DAS)
 */
async function getRecords(req, res) {
    const userId = req.user.id;
    const { deviceSerial, startTime, endTime } = req.body;
    if (!deviceSerial) return res.status(400).json({ code: "400", msg: "Missing Serial Number." });

    try {
        const camera = await Camera.findOne({ userId, deviceSerial });
        if (!camera) {
            return res.status(403).json({ code: "403", msg: "You do not have permission to access this camera." });
        }

        const data = await ezvizService.getLocalRecords({ deviceSerial, startTime, endTime });
        res.json(data);
    } catch (error) {
        sendServerError(res, error, { format: 'ezviz' });
    }
}

/**
 * Get playback stream link (m3u8 or ezopen)
 */
async function getPlaybackStream(req, res) {
    const userId = req.user.id;
    const { deviceSerial, startTime, stopTime } = req.body;
    if (!deviceSerial) return res.status(400).json({ code: "400", msg: "Missing Serial Number." });

    try {
        const camera = await Camera.findOne({ userId, deviceSerial });
        if (!camera) {
            return res.status(403).json({ code: "403", msg: "You do not have permission to access this camera." });
        }

        console.log("startTime: ", startTime, "stopTime: ", stopTime);

        // Invalidate / disable old active stream with urlId
        await closePreviousStream(userId, deviceSerial, req.body);

        const { responseData, token, areaDomain } = await ezvizService.getPlaybackAddress({
            deviceSerial,
            code: camera.validateCode,
            startTime,
            stopTime,
            protocol: 1 // ezopen (standard playback for local SD card recording)
        });


        if (responseData.code == '200') {
            if (responseData.data?.id) {
                activeStreamSessions.set(sessionKey(userId, deviceSerial), responseData.data.id);
            }
            responseData.data.accessToken = token;
            responseData.data.areaDomain = areaDomain;
            responseData.data.validateCode = camera.validateCode;
        }
        res.json(responseData);
    } catch (error) {
        sendServerError(res, error, { format: 'ezviz' });
    }
}

/**
 * Disable active stream upon manual request
 */
async function disableStream(req, res) {
    const userId = req.user.id;
    const { deviceSerial, channelNo, urlId, id } = req.body;
    if (!deviceSerial) return res.status(400).json({ code: "400", msg: "Missing Serial Number." });

    try {
        const camera = await Camera.findOne({ userId, deviceSerial });
        if (!camera) {
            return res.status(403).json({ code: "403", msg: "You do not have permission to access this camera." });
        }

        const result = await closePreviousStream(userId, deviceSerial, { urlId, id, channelNo });
        res.json(result || { code: "200", msg: "Stream disabled successfully" });
    } catch (error) {
        sendServerError(res, error, { format: 'ezviz' });
    }
}

/**
 * Take a snapshot right now (capture, store, AI analysis, alerts) and return the result
 */
async function captureNow(req, res) {
    const userId = req.user.id;
    const { deviceSerial } = req.body;
    if (!deviceSerial) return res.status(400).json({ success: false, message: "Missing deviceSerial." });
    try {
        const camera = await Camera.findOne({ userId, deviceSerial });
        if (!camera) {
            return res.status(404).json({ success: false, message: "Camera not found or permission denied." });
        }
        // Lazy require: captureJob pulls in the AI and S3 services
        const { captureAndSaveSnapshot } = require('../cron/captureJob');
        const saved = await captureAndSaveSnapshot(deviceSerial);
        if (!saved) {
            return res.status(502).json({ success: false, code: 'CAPTURE_FAILED', message: "The camera did not return an image. It may be offline." });
        }
        const snapshot = await Snapshot.findById(saved._id);
        res.json({
            success: true,
            snapshot,
            count: snapshot?.aiProcessed ? countPests(snapshot.aiResults?.summary) : null
        });
    } catch (err) {
        sendServerError(res, err, { context: 'Capture now' });
    }
}

/**
 * Device health for the user's cameras: last capture, snapshots and AI success over the last 24h
 */
async function getCamerasHealth(req, res) {
    try {
        const userId = req.user.id;
        const cameras = await Camera.find({ userId });
        const serials = [...new Set(cameras.map(c => c.deviceSerial))];
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const [recent, latest] = await Promise.all([
            Snapshot.aggregate([
                { $match: { deviceSerial: { $in: serials }, createdAt: { $gte: since } } },
                { $group: { _id: '$deviceSerial', total: { $sum: 1 }, analyzed: { $sum: { $cond: ['$aiProcessed', 1, 0] } } } }
            ]),
            Snapshot.aggregate([
                { $match: { deviceSerial: { $in: serials } } },
                { $sort: { createdAt: -1 } },
                { $group: { _id: '$deviceSerial', lastSnapshotAt: { $first: '$createdAt' } } }
            ])
        ]);
        const recentBy = new Map(recent.map(r => [r._id, r]));
        const latestBy = new Map(latest.map(r => [r._id, r.lastSnapshotAt]));

        res.json({
            success: true,
            health: cameras.map(cam => {
                const r = recentBy.get(cam.deviceSerial) || { total: 0, analyzed: 0 };
                return {
                    deviceSerial: cam.deviceSerial,
                    status: cam.status,
                    lastSync: cam.lastSync,
                    lastCaptureAt: cam.lastCaptureAt,
                    lastSnapshotAt: latestBy.get(cam.deviceSerial) || null,
                    snapshots24h: r.total,
                    analyzed24h: r.analyzed,
                    // null when nothing was captured, so the UI shows "--" instead of a misleading 0%
                    aiSuccessRate: r.total > 0 ? Math.round((r.analyzed / r.total) * 100) : null,
                    captureIntervalMinutes: cam.captureIntervalMinutes,
                    captureDaytimeOnly: cam.captureDaytimeOnly
                };
            })
        });
    } catch (err) {
        sendServerError(res, err, { context: 'Camera health' });
    }
}

module.exports = {
    captureNow,
    getCamerasHealth,
    getUserCameras,
    addCamera,
    deleteCamera,
    updateCamera,
    updateCameraLocation,
    updateCameraCode,
    getLiveStream,
    getRecords,
    getPlaybackStream,
    disableStream
};

