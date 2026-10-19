const mongoose = require('mongoose');

const RETENTION_DAYS = 30;

/**
 * How a camera's previous boot ended when it was not a normal restart (crash, watchdog, brownout): the reason, the last
 * log lines before the reset and, on cameras with a coredump partition, the panicking task, PC and backtrace
 * (camos-esp32-trap logfwd.c `crash` event, or POST /api/device/logs). Kept 30 days.
 */
const cameraCrashSchema = new mongoose.Schema({
    deviceSerial: { type: String, required: true, index: true },
    at: { type: Date, default: Date.now, index: { expires: RETENTION_DAYS * 24 * 60 * 60 } },
    reason: { type: String, default: '' },
    detail: { type: String, default: '' },
    fw: { type: String, default: '' },
    logTail: { type: String, default: '' },
    coredump: {
        task: { type: String, default: undefined },
        pc: { type: String, default: undefined },
        backtrace: { type: [String], default: undefined },
        corrupted: { type: Boolean, default: undefined },
        elfSha256: { type: String, default: undefined }
    },
    source: { type: String, enum: ['mqtt', 'http'], default: 'mqtt' }
});

const CameraCrash = mongoose.model('CameraCrash', cameraCrashSchema);

module.exports = CameraCrash;
module.exports.RETENTION_DAYS = RETENTION_DAYS;
