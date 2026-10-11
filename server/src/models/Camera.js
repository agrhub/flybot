const mongoose = require('mongoose');

/**
 * A person a camera is shared with. `userId` is null for an invitation to an email
 * that has no account yet; it is filled in once that person verifies the address.
 */
const shareSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    email: { type: String, required: true, lowercase: true, trim: true },
    sharedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    sharedAt: { type: Date, default: Date.now },
    // Set when the access comes from sharing the camera's farm (managed by farmService)
    viaFarm: { type: mongoose.Schema.Types.ObjectId, ref: 'Farm', default: null },
    // Set when the access comes from membership of the camera's organization (managed by orgService)
    viaOrg: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },
    orgRole: { type: String, enum: ['owner', 'manager', 'member', null], default: null }
}, { _id: false });

const cameraSchema = new mongoose.Schema({
    // Owner (the account that registered the device)
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    // A physical device can be registered only once; others get access through sharing
    deviceSerial: { type: String, required: true, unique: true },
    sharedWith: { type: [shareSchema], default: [] },
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
    trapType: { type: String, default: 'Yellow Sticky Trap' }, // Trap modality (free text)
    // How counts behave (constants/trap.js): "sticky" glue card (counts accumulate) or
    // "lure" trap without glue (a photo shows the flies present at that moment)
    trapKind: { type: String, enum: ['sticky', 'lure'], default: 'sticky' },
    cropType: { type: String, default: 'Mango Orchard' }, // Agricultural crop
    // Pest alert fires when one scan counts at least this many insects
    alertThreshold: { type: Number, default: 15, min: 1 },
    // Automatic snapshot schedule
    captureIntervalMinutes: { type: Number, enum: [15, 30, 60, 120], default: 30 },
    // Only capture during daylight hours (06:00-18:00 local time); sticky traps are unreadable at night
    captureDaytimeOnly: { type: Boolean, default: false },
    // Farm and plot the trap belongs to (null = not assigned)
    farmId: { type: mongoose.Schema.Types.ObjectId, ref: 'Farm', default: null, index: true },
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    plotId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plot', default: null, index: true },
    // Sticky card: when it was last replaced (latest "card_replaced" maintenance event) and
    // after how many days to remind (0 = off)
    cardReplacedAt: { type: Date, default: null },
    cardReminderDays: { type: Number, default: 7, min: 0, max: 60 },
    // Problems found in the latest photo (services/imageQuality.js)
    imageQuality: {
        issues: { type: [String], default: undefined },
        checkedAt: { type: Date, default: undefined }
    },
    // Last automatic or manual capture attempt for this device
    lastCaptureAt: { type: Date, default: null },
    addedAt: { type: Date, default: Date.now },
    lastSync: { type: Date, default: Date.now }
});

cameraSchema.index({ 'sharedWith.userId': 1 });
cameraSchema.index({ 'sharedWith.email': 1 });

const Camera = mongoose.model('Camera', cameraSchema);

module.exports = Camera;
