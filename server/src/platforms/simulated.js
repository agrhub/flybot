const { Camera } = require('../models');

/**
 * Simulated demo cameras (scripts/demo_sim.js, services/demoSim.js): no device behind them. Their
 * photos are labeled synthetic pictures released by the simulation and analyzed by the real vision
 * pipeline; nothing here ever reaches EZVIZ, AWS IoT or Kinesis.
 */
const PLATFORM = 'simulated';

class SimulatedCameraError extends Error {
    constructor(message = 'Simulated cameras have no device: no live view, capture or settings.') {
        super(message);
        this.code = 'SIMULATED_CAMERA';
    }
}

function listCameras(filter = {}) {
    return Camera.find({ ...filter, platform: PLATFORM });
}

async function snapshot() {
    return null;
}

async function liveSession() {
    throw new SimulatedCameraError();
}

/** The photo timeline, as for CamOS cameras. */
function playback(deviceSerial, opts) {
    return require('./camos').playback(deviceSerial, opts).then(result => ({ ...result, platform: PLATFORM }));
}

async function setCaptureSchedule(deviceSerial, minutes) {
    return { platform: PLATFORM, minutes, applied: false };
}

async function getStatus(deviceSerial) {
    const camera = await Camera.findOne({ deviceSerial }).select('status').lean();
    return camera ? { platform: PLATFORM, online: Number(camera.status) === 1, power: { mode: 'powered' }, sleeping: false, wakeAt: null, nextWakeAt: null } : null;
}

module.exports = {
    PLATFORM,
    SimulatedCameraError,
    listCameras,
    snapshot,
    liveSession,
    playback,
    setCaptureSchedule,
    getStatus
};
