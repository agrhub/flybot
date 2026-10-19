const mongoose = require('mongoose');

const UPDATE_STATES = ['pending', 'sent', 'installing', 'rebooting', 'succeeded', 'failed', 'rolled_back', 'cancelled'];
const OPEN_STATES = ['pending', 'sent', 'installing', 'rebooting'];
const WAIT_REASONS = ['offline', 'sleeping', 'battery_low', 'outside_hour', 'disabled'];

/**
 * One firmware update of one camera (services/firmwareService.js): asked by an admin (a rollout, several
 * cameras share a batchId), by the owner, or by the camera's automatic updates. A camera has at most one
 * open update (pending / sent / installing / rebooting).
 */
const firmwareUpdateSchema = new mongoose.Schema({
    deviceSerial: { type: String, required: true },
    firmwareId: { type: mongoose.Schema.Types.ObjectId, ref: 'Firmware', required: true },
    model: { type: String, default: '' },
    fromVersion: { type: String, default: '' },
    toVersion: { type: String, required: true },
    batchId: { type: String, default: undefined },
    source: { type: String, enum: ['admin', 'owner', 'auto'], required: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: undefined },
    state: { type: String, enum: UPDATE_STATES, default: 'pending' },
    waitReason: { type: String, enum: [...WAIT_REASONS, null], default: null },
    // Firmware 0.7.0 and later: download progress (ota_progress events)
    progress: { type: Number, default: undefined },
    attempts: { type: Number, default: 0 },
    error: { type: String, default: undefined },
    detail: { type: String, default: undefined },
    sentAt: { type: Date, default: undefined },
    installedAt: { type: Date, default: undefined },
    finishedAt: { type: Date, default: undefined },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

firmwareUpdateSchema.index({ deviceSerial: 1, createdAt: -1 });
firmwareUpdateSchema.index({ state: 1 });
firmwareUpdateSchema.index({ batchId: 1 }, { sparse: true });
// One open update per camera
firmwareUpdateSchema.index({ deviceSerial: 1 }, { unique: true, partialFilterExpression: { state: { $in: OPEN_STATES } }, name: 'one_open_update' });

const FirmwareUpdate = mongoose.model('FirmwareUpdate', firmwareUpdateSchema);

module.exports = FirmwareUpdate;
module.exports.UPDATE_STATES = UPDATE_STATES;
module.exports.OPEN_STATES = OPEN_STATES;
module.exports.WAIT_REASONS = WAIT_REASONS;
