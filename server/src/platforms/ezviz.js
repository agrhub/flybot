const axios = require('axios');
const { Camera, Snapshot } = require('../models');
const ezvizService = require('../services/ezvizService');
const { CAPTURE_INTERVALS } = require('../services/captureSchedule');

/**
 * CameraPlatform "ezviz": the EZVIZ Open Platform cameras FlyBot has always managed. This
 * adapter only wraps services/ezvizService.js: what current users get is unchanged.
 */
const PLATFORM = 'ezviz';

function listCameras(filter = {}) {
    return Camera.find({ ...filter, $or: [{ platform: PLATFORM }, { platform: { $exists: false } }] });
}

/**
 * Take a photo now. Returns { buffer, picUrl } (the photo and the link it was downloaded from,
 * which the Roboflow provider can fetch directly) or null when the camera gave no image.
 */
async function snapshot(deviceSerial) {
    const captureRes = await ezvizService.captureDevice(deviceSerial);
    if (captureRes?.code != '200' || !captureRes.data?.picUrl) {
        console.log(`Can't get image from device ${deviceSerial}`);
        return null;
    }
    const picUrl = captureRes.data.picUrl;
    const imageRes = await axios.get(picUrl, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: 20 * 1024 * 1024 });
    return { buffer: Buffer.from(imageRes.data, 'binary'), picUrl };
}

/**
 * The EZVIZ live address (HLS or ezopen, "existing live URL shape"). The HTTP route keeps the
 * stream bookkeeping (per-viewer stream ids, encryption retries): this returns the raw answer.
 */
async function liveSession(deviceSerial, { code = '', protocol = 2, quality = 1 } = {}) {
    const result = await ezvizService.getLiveAddress({ deviceSerial, code, protocol, quality });
    return { platform: PLATFORM, ...(result || {}) };
}

/** Recorded video on the camera's SD card, between `from` and `to` (EZVIZ time strings). */
async function playback(deviceSerial, { from, to } = {}) {
    const records = await ezvizService.getLocalRecords({ deviceSerial, startTime: from, endTime: to });
    return { platform: PLATFORM, kind: 'video', records: records?.data || [], raw: records };
}

/** The capture schedule lives in FlyBot (cron/captureJob.js polls the camera). */
async function setCaptureSchedule(deviceSerial, minutes) {
    if (!CAPTURE_INTERVALS.includes(minutes)) throw new Error(`minutes must be one of ${CAPTURE_INTERVALS.join(', ')}`);
    await Camera.updateMany({ deviceSerial }, { $set: { captureIntervalMinutes: minutes } });
    return { platform: PLATFORM, minutes, applied: 'flybot' };
}

async function getStatus(deviceSerial) {
    const camera = await Camera.findOne({ deviceSerial }).select('status lastSync lastCaptureAt captureIntervalMinutes').lean();
    if (!camera) return null;
    const latest = await Snapshot.findOne({ deviceSerial }).sort({ createdAt: -1 }).select('createdAt').lean();
    return {
        platform: PLATFORM,
        online: Number(camera.status) === 1,
        power: { mode: 'powered' },
        sleeping: false,
        wakeAt: null,
        lastSeenAt: camera.lastSync || null,
        lastPhotoAt: latest?.createdAt || null,
        captureIntervalMinutes: camera.captureIntervalMinutes
    };
}

module.exports = {
    PLATFORM,
    listCameras,
    snapshot,
    liveSession,
    playback,
    setCaptureSchedule,
    getStatus
};
