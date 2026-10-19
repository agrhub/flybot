const mongoose = require('mongoose');

const RETENTION_HOURS = 24;
// Lines kept per camera at most (services/cameraLogService.js trims the oldest)
const MAX_LINES_PER_CAMERA = 20000;

/**
 * One line of a camera's console log, forwarded on request (camos-esp32-trap logfwd.c: MQTT camos/<serial>/log, or
 * POST /api/device/logs when MQTT is down). Secrets are removed on the camera before they leave it. Kept 24 h.
 */
const cameraLogSchema = new mongoose.Schema({
    deviceSerial: { type: String, required: true },
    session: { type: String, default: '' },
    seq: { type: Number, default: 0 },
    // When the line was logged (from the camera's uptime stamp and clock), and when FlyBot got it
    at: { type: Date, required: true },
    // 1 error, 2 warn, 3 info, 4 debug, 5 verbose (lines that are not esp_log output count as info)
    lvl: { type: Number, min: 1, max: 5, default: 3 },
    tag: { type: String, default: '' },
    msg: { type: String, default: '' },
    source: { type: String, enum: ['mqtt', 'http'], default: 'mqtt' },
    receivedAt: { type: Date, default: Date.now, index: { expires: RETENTION_HOURS * 60 * 60 } }
});

cameraLogSchema.index({ deviceSerial: 1, at: -1 });

const CameraLog = mongoose.model('CameraLog', cameraLogSchema);

module.exports = CameraLog;
module.exports.RETENTION_HOURS = RETENTION_HOURS;
module.exports.MAX_LINES_PER_CAMERA = MAX_LINES_PER_CAMERA;
