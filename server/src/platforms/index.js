const { Camera } = require('../models');

/**
 * CameraPlatform adapters: how FlyBot reaches a camera (Camera.platform).
 *
 * Every adapter implements the same interface, keyed by the camera's deviceSerial:
 *   listCameras(filter)                  -> Camera query of this platform
 *   snapshot(cameraId)                   -> { buffer, picUrl? } | { snapshot } (already stored) | null
 *   liveSession(cameraId, { user })      -> { platform, ... } (ezviz: live address; kinesis: viewer config)
 *   playback(cameraId, { from, to })     -> { platform, kind, ... } (video records, or the snapshot timeline)
 *   setCaptureSchedule(cameraId, minutes)-> { platform, minutes, applied }
 *   getStatus(cameraId)                  -> { platform, online, power: { mode }, sleeping, wakeAt, nextWakeAt, ... } | null
 *
 *   ezviz   - EZVIZ Open Platform (the existing cameras; behaviour unchanged)
 *   camos   - CamOS cameras over AWS IoT Core + the device API; live view through kinesis
 *   kinesis - Kinesis Video Streams WebRTC live view only
 */
const adapters = {
    ezviz: require('./ezviz'),
    camos: require('./camos'),
    kinesis: require('./kinesis')
};
const PLATFORMS = Object.keys(adapters);
const DEFAULT_PLATFORM = 'ezviz';
const INTERFACE = ['listCameras', 'snapshot', 'liveSession', 'playback', 'setCaptureSchedule', 'getStatus'];

const platformOf = (camera) => (camera && PLATFORMS.includes(camera.platform) ? camera.platform : DEFAULT_PLATFORM);

/** The adapter for a platform name or a camera document. */
function get(platformOrCamera) {
    const name = typeof platformOrCamera === 'string' ? platformOrCamera : platformOf(platformOrCamera);
    const adapter = adapters[name];
    if (!adapter) throw new Error(`Unknown camera platform "${name}"`);
    return adapter;
}

/** The adapter of a camera by serial (ezviz when the camera is unknown, as before). */
async function forSerial(deviceSerial) {
    const camera = await Camera.findOne({ deviceSerial }).select('platform').lean();
    return get(platformOf(camera));
}

module.exports = {
    PLATFORMS,
    DEFAULT_PLATFORM,
    INTERFACE,
    adapters,
    platformOf,
    get,
    forSerial
};
