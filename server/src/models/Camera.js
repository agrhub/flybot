const mongoose = require('mongoose');

const cameraSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deviceSerial: { type: String, required: true },
    validateCode: { type: String, default: '' },
    deviceName: { type: String, default: 'Camera' },
    deviceType: { type: String, default: '' },
    model: { type: String, default: '' },
    deviceVersion: { type: String, default: '' },
    defence: { type: Number, default: 0 }, // 1: Arm/Defence enabled, 0: Disabled
    updateTime: { type: String, default: '' },
    isShared: { type: String, default: '0' },
    picUrl: { type: String, default: '' },
    thumbnailUrl: { type: String, default: '' }, // Camera snapshot thumbnail image
    status: { type: Number, default: 0 }, // 1: Online, 0: Offline
    isEncrypt: { type: Number, default: 0 }, // 1: Encrypted, 0: Unencrypted
    latitude: { type: Number, default: null }, // GPS Latitude
    longitude: { type: Number, default: null }, // GPS Longitude
    locationAddress: { type: String, default: '' }, // Orchard address or plot name
    trapType: { type: String, default: 'Yellow Sticky Trap' }, // Trap modality
    cropType: { type: String, default: 'Mango Orchard' }, // Agricultural crop
    // Pest alert fires when one scan counts at least this many insects (per user, per camera)
    alertThreshold: { type: Number, default: 15, min: 1 },
    addedAt: { type: Date, default: Date.now },
    lastSync: { type: Date, default: Date.now }
});

const Camera = mongoose.model('Camera', cameraSchema);

module.exports = Camera;
