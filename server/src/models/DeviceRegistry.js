const mongoose = require('mongoose');

/**
 * The serial registry: cameras made or bought for sale, entered by an admin (one by one or from a CSV)
 * before a customer adds them to an account (services/registryService.js). The verify code is the one on
 * the camera's label; it is never listed, only revealed on request (audited).
 */
const deviceRegistrySchema = new mongoose.Schema({
    serial: { type: String, required: true, unique: true, uppercase: true, trim: true },
    verifyCode: { type: String, required: true, uppercase: true, trim: true },
    platform: { type: String, enum: ['camos'], default: 'camos' },
    model: { type: String, default: '' },
    hwVersion: { type: String, default: '' },
    batch: { type: String, default: '' },
    note: { type: String, default: '' },
    // A blocked serial is refused at claim and self-registration (lost, stolen or returned stock)
    disabled: { type: Boolean, default: false },
    disabledReason: { type: String, default: '' },
    // Set when a customer adds the camera to an account
    claimedAt: { type: Date, default: undefined },
    claimedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: undefined },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: undefined },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

deviceRegistrySchema.index({ batch: 1 });

const DeviceRegistry = mongoose.model('DeviceRegistry', deviceRegistrySchema);

module.exports = DeviceRegistry;
