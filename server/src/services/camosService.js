const axios = require('axios');
const { CAMOS_API_URL, CAMOS_APP_ID, CAMOS_SECRET_KEY } = require('../config/env');

/**
 * Client of the CamOS Open API (camos-ai-camera/protocol/open-api.md): the camera platform of
 * the AI cameras, used the way ezvizService uses the EZVIZ Open Platform.
 */

// A request CamOS never answers would otherwise hold up a capture run for good
const CAMOS_TIMEOUT_MS = 20000;
// A capture waits for the camera to take and upload the photo (CamOS gives it 60 s)
const CAPTURE_TIMEOUT_MS = 70000;
// The token is renewed this long before CamOS says it expires
const TOKEN_REFRESH_MARGIN_MS = 60 * 60 * 1000;

/**
 * A CamOS answer that is not a success. `code` is the CamOS error code (VERIFY_CODE_INVALID,
 * DEVICE_OFFLINE...), or CAMOS_UNREACHABLE / CAMOS_NOT_CONFIGURED; `status` the HTTP status.
 */
class CamosError extends Error {
    constructor(message, { status = 502, code = 'CAMOS_ERROR', deviceCode = null } = {}) {
        super(message);
        this.name = 'CamosError';
        this.status = status;
        this.code = code;
        this.deviceCode = deviceCode;
    }
}

function isConfigured() {
    return !!(CAMOS_API_URL && CAMOS_APP_ID && CAMOS_SECRET_KEY);
}

function toCamosError(error) {
    if (error instanceof CamosError) return error;
    const status = error.response?.status;
    const body = error.response?.data?.error;
    return new CamosError(body?.message || error.message, {
        status: status || 502,
        code: body?.code || (status ? 'CAMOS_ERROR' : 'CAMOS_UNREACHABLE'),
        deviceCode: body?.deviceCode || null
    });
}

let cachedToken = { accessToken: null, expiresAt: 0 };
// One token request at a time, however many calls need a token
let pendingToken = null;

async function fetchToken() {
    if (!isConfigured()) {
        throw new CamosError('CamOS is not configured', { status: 503, code: 'CAMOS_NOT_CONFIGURED' });
    }
    try {
        const response = await axios.post(`${CAMOS_API_URL}/token`, { appId: CAMOS_APP_ID, secretKey: CAMOS_SECRET_KEY }, { timeout: CAMOS_TIMEOUT_MS });
        const data = response.data?.data;
        if (!data?.accessToken) throw new CamosError('CamOS returned no access token');
        cachedToken = { accessToken: data.accessToken, expiresAt: Number(data.expiresAt) || 0 };
        console.log('✅ CamOS token refreshed');
        return cachedToken.accessToken;
    } catch (error) {
        throw toCamosError(error);
    }
}

async function getValidToken() {
    if (cachedToken.accessToken && Date.now() < cachedToken.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
        return cachedToken.accessToken;
    }
    if (!pendingToken) pendingToken = fetchToken().finally(() => { pendingToken = null; });
    return pendingToken;
}

/**
 * Call the Open API and return its `data`. A refused token (revoked, CamOS restarted) is
 * renewed once.
 */
async function request(method, path, { body, params, timeout = CAMOS_TIMEOUT_MS } = {}, retried = false) {
    const token = await getValidToken();
    try {
        const response = await axios({
            method,
            url: `${CAMOS_API_URL}${path}`,
            data: body,
            params,
            timeout,
            headers: { Authorization: `Bearer ${token}` }
        });
        return response.data?.data;
    } catch (error) {
        if (error.response?.status === 401 && !retried) {
            cachedToken = { accessToken: null, expiresAt: 0 };
            return request(method, path, { body, params, timeout }, true);
        }
        throw toCamosError(error);
    }
}

const devicePath = (serial, rest = '') => `/devices/${encodeURIComponent(serial)}${rest}`;

/**
 * Bind a camera to FlyBot with the serial and verification code from its label. Returns the
 * device and a short-lived provisionToken for the network QR the camera scans.
 */
function activateDevice({ serial, verifyCode, name }) {
    return request('post', '/devices/activate', { body: { serial, verifyCode, name } });
}

// Give the camera back (factory reset on the device); someone else can then activate it
function deactivateDevice(serial, { deleteCloudData = true } = {}) {
    return request('post', devicePath(serial, '/deactivate'), { body: { deleteCloudData } });
}

function getDevice(serial) {
    return request('get', devicePath(serial));
}

/**
 * Take a photo now. Returns { imageUrl, expiresAt, ai? }: `ai` only when `detectionId` names a
 * detection for the camera to run on the photo. imageUrl expires: download it right away.
 */
function captureImage(serial, { detectionId } = {}) {
    return request('post', devicePath(serial, '/capture'), { body: detectionId ? { detectionId } : {}, timeout: CAPTURE_TIMEOUT_MS });
}

/**
 * Start (or join) the live stream. Returns { streamId, playToken, webrtc, hls, expiresAt } for
 * the browser player; `externalUserId` is recorded in CamOS's audit log.
 */
function startLive(serial, { quality = 'auto', externalUserId } = {}) {
    return request('post', devicePath(serial, '/live'), { body: { quality, externalUserId } });
}

function stopLive(serial, streamId) {
    return request('delete', devicePath(serial, `/live/${encodeURIComponent(streamId)}`));
}

// Recordings on the camera's SD card between two times (ms): { segments: [{ start, end, sizeMB, events }] }
function listSdRecords(serial, { from, to }) {
    return request('get', devicePath(serial, '/sd-records'), { params: { from, to } });
}

// Have the camera upload an SD-card recording: { jobId, status } and, once ready, { url, expiresAt }
function requestSdPlayback(serial, { start, end, externalUserId }) {
    return request('post', devicePath(serial, '/sd-playback'), { body: { start, end, externalUserId } });
}

function getJob(jobId) {
    return request('get', `/jobs/${encodeURIComponent(jobId)}`);
}

// What the camera detects and when (the shadow's `detections`, protocol section 8)
function setDetections(serial, detections) {
    return request('put', devicePath(serial, '/detections'), { body: { detections } });
}

// Events since a time, to catch up on webhooks FlyBot missed
function listEvents({ serial, since, types, limit = 100 } = {}) {
    const params = { since, types: Array.isArray(types) ? types.join(',') : types, limit };
    return request('get', serial ? devicePath(serial, '/events') : '/events', { params });
}

module.exports = {
    CamosError,
    isConfigured,
    getValidToken,
    activateDevice,
    deactivateDevice,
    getDevice,
    captureImage,
    startLive,
    stopLive,
    listSdRecords,
    requestSdPlayback,
    getJob,
    setDetections,
    listEvents
};
