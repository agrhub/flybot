const axios = require('axios');
const { APP_KEY, SECRET_KEY, APP_DOMAIN, DOMAIN_AREAS } = require('../config/env');
const { Camera } = require('../models');
const notificationService = require('./notificationService');

// In-memory token cache to prevent exceeding EZVIZ Rate Limits
let cachedToken = {
    accessToken: null,
    expireTime: 0,
    areaDomain: APP_DOMAIN
};

/**
 * Helper to convert Object to URL-encoded form data string
 * EZVIZ API requires Content-Type: application/x-www-form-urlencoded
 */
const toFormData = (obj) => {
    return Object.keys(obj)
        .filter(key => typeof obj[key] !== 'undefined')
        .map(key => encodeURIComponent(key) + '=' + encodeURIComponent(obj[key]))
        .join('&');
};

/**
 * Fetch new Access Token from EZVIZ Open Platform
 */
async function updateAccessToken() {
    try {
        const params = toFormData({
            appKey: APP_KEY,
            appSecret: SECRET_KEY
        });

        const response = await axios.post(APP_DOMAIN + '/api/lapp/token/get', params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        if (response.data.code === '200') {
            cachedToken.accessToken = response.data?.data?.accessToken;
            cachedToken.expireTime = response.data?.data?.expireTime;
            cachedToken.areaDomain = response.data?.data?.areaDomain || DOMAIN_AREAS['vi'] || APP_DOMAIN;

            console.log("✅ Updated new EZVIZ Token:", cachedToken.accessToken);
            return cachedToken.accessToken;
        } else {
            console.error("❌ EZVIZ Token fetch error:", response.data.msg);
            return null;
        }
    } catch (error) {
        console.error("❌ EZVIZ Token API request error:", error.message);
        return null;
    }
}

/**
 * Retrieve valid Access Token (auto-refresh if expired or near expiration)
 */
async function getValidToken() {
    const now = Date.now();
    if (!cachedToken.accessToken || now >= (cachedToken.expireTime - 3600000)) {
        console.log("🔄 Token expired or expiring soon. Requesting new token...");
        return await updateAccessToken();
    }
    return cachedToken.accessToken;
}

function getCachedToken() {
    return cachedToken;
}

/**
 * Synchronize camera info and status from EZVIZ Cloud to local database
 */
async function syncCameraStatus(deviceSerial) {
    try {
        const token = await getValidToken();
        if (!token) return;

        if (!deviceSerial) {
            let pageStart = 0;
            const pageSize = 50;
            let hasMore = true;

            while (hasMore) {
                const params = toFormData({
                    accessToken: token,
                    pageStart: pageStart,
                    pageSize: pageSize
                });

                const response = await axios.post(cachedToken.areaDomain + '/api/lapp/device/list', params, {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                });

                if (response.data.code === '200' && Array.isArray(response.data.data)) {
                    const deviceList = response.data.data;
                    if (deviceList.length === 0) {
                        hasMore = false;
                        break;
                    }

                    // console.log("sync CameraStatus:", JSON.stringify(deviceList));

                    // Previous status, to detect online/offline transitions for alerts
                    const previous = await Camera.find({ deviceSerial: { $in: deviceList.map(d => d.deviceSerial) } }).select('deviceSerial status');
                    const previousStatus = new Map(previous.map(c => [c.deviceSerial, Number(c.status)]));

                    const updatePromises = deviceList.map(item => {
                        const updateData = {
                            deviceName: item.deviceName,
                            status: item.status, // 1: Online, 0: Offline
                            deviceType: item.deviceType || '',
                            model: item.model || '',
                            deviceVersion: item.deviceVersion || '',
                            defence: item.defence ?? 0,
                            updateTime: item.updateTime || '',
                            lastSync: new Date()
                        };
                        if (typeof item.isShared !== 'undefined') {
                            updateData.isShared = String(item.isShared);
                        }
                        if (item.picUrl && typeof item.picUrl === 'string' && item.picUrl.trim() !== '') {
                            updateData.picUrl = item.picUrl;
                        }
                        if (typeof item.latitude !== 'undefined' && item.latitude) {
                            updateData.latitude = Number(item.latitude);
                        }
                        if (typeof item.longitude !== 'undefined' && item.longitude) {
                            updateData.longitude = Number(item.longitude);
                        }
                        return Camera.updateMany(
                            { deviceSerial: item.deviceSerial },
                            { $set: updateData }
                        );
                    });

                    await Promise.all(updatePromises);

                    for (const item of deviceList) {
                        const before = previousStatus.get(item.deviceSerial);
                        if (before !== undefined && before !== Number(item.status)) {
                            notificationService.cameraStatusChanged(item.deviceSerial, Number(item.status))
                                .catch(err => console.error(`⚠️ Status alert failed (${item.deviceSerial}):`, err.message));
                        }
                    }

                    if (deviceList.length < pageSize) {
                        hasMore = false;
                    } else {
                        pageStart += 1;
                    }

                    console.log(`[${new Date().toLocaleTimeString()}] 🔄 Synced page ${pageStart}: ${deviceList.length} devices.`);
                } else {
                    console.error("❌ Camera status sync error:", response.data.msg);
                    hasMore = false;
                }
            }
        } else {
            const params = toFormData({
                accessToken: token,
                deviceSerial: deviceSerial
            });

            const response = await axios.post(cachedToken.areaDomain + '/api/lapp/device/info', params, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });

            if (response.data.code === '200' && response.data.data && response.data.data.deviceSerial) {
                const device = response.data.data;
                const updateData = {
                    deviceName: device.deviceName,
                    status: device.status,
                    deviceType: device.deviceType || '',
                    model: device.model || '',
                    deviceVersion: device.deviceVersion || '',
                    defence: device.defence ?? 0,
                    updateTime: device.updateTime || '',
                    lastSync: new Date()
                };
                if (typeof device.isShared !== 'undefined') {
                    updateData.isShared = String(device.isShared);
                }
                if (device.picUrl && typeof device.picUrl === 'string' && device.picUrl.trim() !== '') {
                    updateData.picUrl = device.picUrl;
                }
                return Camera.updateMany(
                    { deviceSerial: deviceSerial },
                    { $set: updateData }
                );
            } else {
                console.error("❌ Camera status sync error:", response.data.msg);
            }
        }
    } catch (error) {
        console.error("❌ System error during sync:", error.message);
    }
}

async function getDeviceInfo(deviceSerial) {
    try {
        const token = await getValidToken();
        if (!token) return;

        const params = toFormData({
            accessToken: token,
            deviceSerial: deviceSerial
        });

        const response = await axios.post(cachedToken.areaDomain + '/api/lapp/device/info', params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        if (response.data.code === '200' && response.data.data && response.data.data.deviceSerial) {
            const device = response.data;
            return device;
        } else {
            console.error("❌ Camera status sync error:", response.data.msg);
            return null;
        }
    } catch (error) {
        console.error("❌ System error during sync:", error.message);
        return null;
    }
}

/**
 * Add camera device to EZVIZ Open Platform account
 */
async function addCameraToEzviz(deviceSerial, validateCode) {
    const token = await getValidToken();
    const params = toFormData({
        accessToken: token,
        deviceSerial: deviceSerial,
        validateCode: validateCode
    });

    const infoResponse = await axios.post(cachedToken.areaDomain + '/api/lapp/device/add', params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    return infoResponse.data;
}

/**
 * Get live stream link (m3u8/HLS or ezopen) from API v2
 */
async function getLiveAddress({ deviceSerial, code = '', protocol = 2, quality = 1, supportH265 = 0, containerFormat = 0 }) {
    const token = await getValidToken();
    const payload = {
        accessToken: token,
        deviceSerial: deviceSerial,
        channelNo: 1,
        protocol: protocol, // 1: ezopen, 2: hls, 3: rtmp, 4: flv, 5: llhls
        type: 1, // Preview
        quality: quality, // 1: Main stream (HD), 2: Sub-stream (Smooth)
        supportH265: supportH265, // 0 or 1
        containerFormat: containerFormat // 0: TS, 1: FMP4
    };

    if (code && code.trim()) {
        const trimmedCode = code.trim();
        payload.code = trimmedCode;
        payload.validateCode = trimmedCode;
        payload.validCode = trimmedCode;
        payload.verifyCode = trimmedCode;
    }

    const params = toFormData(payload);
    const response = await axios.post(cachedToken.areaDomain + '/api/lapp/v2/live/address/get', params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    return { responseData: response.data, token, areaDomain: cachedToken.areaDomain };
}

/**
 * Get local recorded video playback list from camera (API v3 DAS)
 */
async function getLocalRecords({ deviceSerial, startTime, endTime }) {
    const token = await getValidToken();
    const params = toFormData({
        recordType: 1,
        startTime: startTime,
        endTime: endTime
    });

    const response = await axios.get(cachedToken.areaDomain + '/api/v3/das/device/local/video/query?' + params, {
        headers: {
            accessToken: token,
            deviceSerial: deviceSerial
        }
    });

    return response.data;
}

/**
 * Get video playback address (playback stream URL)
 */
async function getPlaybackAddress({ deviceSerial, code = '', startTime, stopTime, protocol = 1 }) {
    const token = await getValidToken();
    const params = toFormData({
        accessToken: token,
        deviceSerial: deviceSerial,
        type: 2, // 2: Local recording playback
        protocol: protocol, // 1: ezopen (local recording playback), 2: hls
        code: code,
        validateCode: code,
        validCode: code,
        verifyCode: code,
        startTime: startTime,
        stopTime: stopTime,
    });


    const response = await axios.post(cachedToken.areaDomain + '/api/lapp/v2/live/address/get', params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    return { responseData: response.data, token, areaDomain: cachedToken.areaDomain };
}

/**
 * Capture snapshot directly from device via EZVIZ Cloud
 */
async function captureDevice(deviceSerial) {
    const token = await getValidToken();
    const params = toFormData({ accessToken: token, deviceSerial: deviceSerial, channelNo: 1 });

    const response = await axios.post(cachedToken.areaDomain + '/api/lapp/device/capture', params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    return response.data;
}

/**
 * Invalidate/Disable current active stream for device (free old stream ID)
 * Reference: https://open.ys7.com/help/en/534
 */
async function disableLiveAddress({ deviceSerial, channelNo = 1, urlId = '' }) {
    try {
        const token = await getValidToken();
        const baseParams = {
            accessToken: token,
            deviceSerial: deviceSerial,
            channelNo: channelNo
        };

        if (urlId) {
            baseParams.urlId = urlId;
        }

        let params = toFormData(baseParams);
        let response = await axios.post(cachedToken.areaDomain + '/api/lapp/v2/live/address/disable', params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        // If EZVIZ reports format error due to 18-digit vs 19-digit validator regex
        if (response.data && response.data.code === '10001' && urlId && urlId.length > 18) {
            baseParams.urlId = urlId.slice(0, 18);
            response = await axios.post(cachedToken.areaDomain + '/api/lapp/v2/live/address/disable', toFormData(baseParams), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
        }

        console.log(`[EZVIZ] disableLiveAddress (${deviceSerial}, urlId: ${urlId || 'none'}):`, JSON.stringify(response.data));
        return response.data;
    } catch (error) {
        console.warn(`[EZVIZ] disableLiveAddress error (${deviceSerial}):`, error.response?.data || error.message);
        return null;
    }
}


module.exports = {
    toFormData,
    updateAccessToken,
    getValidToken,
    getCachedToken,
    syncCameraStatus,
    addCameraToEzviz,
    getLiveAddress,
    getLocalRecords,
    getPlaybackAddress,
    disableLiveAddress,
    captureDevice,
    getDeviceInfo
};
