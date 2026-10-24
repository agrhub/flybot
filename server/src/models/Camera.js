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

const PLATFORMS = ['ezviz', 'camos', 'kinesis', 'simulated'];

/**
 * A CamOS camera (ESP32 trap, AMB82) reached through AWS IoT Core and the device API
 * (platforms/camos.js, routes/deviceRoutes.js). Tokens are stored hashed (SHA-256) only.
 */
const deviceSchema = new mongoose.Schema({
    // Per-device API token (X-Device-Token), issued by POST /api/device/pair
    tokenHash: { type: String, default: undefined },
    tokenIssuedAt: { type: Date, default: undefined },
    // One-time provisioning token the owner gives the camera (portal / network QR)
    provisionTokenHash: { type: String, default: undefined },
    provisionExpiresAt: { type: Date, default: undefined },
    pairedAt: { type: Date, default: undefined },
    // Zero-touch self-registration (POST /api/device/register): the AWS IoT certificate FlyBot
    // signed from the camera's CSR (public certificate only; the private key never leaves the
    // camera), the CSR's hash for an idempotent retry, and the first MQTT connection
    certificateArn: { type: String, default: undefined },
    certificateId: { type: String, default: undefined },
    certificatePem: { type: String, default: undefined },
    csrHash: { type: String, default: undefined },
    registeredAt: { type: Date, default: undefined },
    firstConnectAt: { type: Date, default: undefined },
    // When IoT Core last saw this camera connect (the presence event's own timestamp): a disconnect event older than
    // it belongs to an earlier session and must not set the camera offline
    connectedAt: { type: Date, default: undefined },
    connectedSession: { type: String, default: undefined },
    // Last AWS cleanup that did not finish (the hourly job tries again)
    cleanupError: { type: String, default: undefined },
    // Timezone sent to the camera (shadow tz) and where it came from: farm | gps | ip | default
    tz: { type: mongoose.Schema.Types.Mixed, default: undefined },
    // AWS IoT thing (default: the serial) and the KVS signaling channel (cam-<serial>)
    thingName: { type: String, default: undefined },
    kvsChannelName: { type: String, default: undefined },
    // The IoT role alias offered to the camera for live view (shadow desired kvs.roleAlias), so it is sent once
    liveCredsAlias: { type: String, default: undefined },
    kvsChannelArn: { type: String, default: undefined },
    // What the camera last reported (device API meta, MQTT state/telemetry, shadow reported)
    fw: { type: String, default: undefined },
    net: { type: String, default: undefined }, // wifi | 4g
    rssi: { type: Number, default: undefined },
    battery: { type: mongoose.Schema.Types.Mixed, default: undefined }, // { mv, pct, charging, solarMv }
    // 4G modem (state net.cell), kept when the camera is on Wi-Fi again; hardware revision (firmware 0.7.0+)
    imei: { type: String, default: undefined },
    iccid: { type: String, default: undefined },
    operator: { type: String, default: undefined },
    hw: { type: String, default: undefined },
    mac: { type: String, default: undefined },
    // Remote log (services/cameraLogService.js): what FlyBot asked for and what the camera reports (reported log)
    log: {
        on: { type: Boolean, default: undefined },
        level: { type: String, default: undefined },
        until: { type: Date, default: undefined },
        session: { type: String, default: undefined },
        requestedLevel: { type: String, default: undefined },
        requestedUntil: { type: Date, default: undefined },
        lastLineAt: { type: Date, default: undefined }
    },
    // How the previous boot ended when it was not a normal restart (models/CameraCrash.js holds the details)
    lastCrash: {
        at: { type: Date, default: undefined },
        reason: { type: String, default: undefined },
        fw: { type: String, default: undefined }
    },
    location: { type: mongoose.Schema.Types.Mixed, default: undefined }, // { lat, lng, fixAt, source: gps | cell, accuracyM }
    power: { type: mongoose.Schema.Types.Mixed, default: undefined }, // { mode: auto | battery | powered }
    sleeping: { type: Boolean, default: undefined },
    wakeAt: { type: Date, default: undefined },
    lastSeenAt: { type: Date, default: undefined },
    // FlyBot asked for a live session at the next wake (shadow desired live.requested)
    liveRequested: { type: Boolean, default: undefined },
    liveRequestedAt: { type: Date, default: undefined },
    // A GPS fix in progress: the camera turns its 4G radio off meanwhile (firmware 0.9.2), so a disconnect is expected
    locatingUntil: { type: Date, default: undefined },
    locatingRpcId: { type: String, default: undefined },
    shadow: {
        reported: { type: mongoose.Schema.Types.Mixed, default: undefined },
        desired: { type: mongoose.Schema.Types.Mixed, default: undefined },
        reportedAt: { type: Date, default: undefined },
        desiredAt: { type: Date, default: undefined }
    }
}, { _id: false });

const cameraSchema = new mongoose.Schema({
    // Simulated demo data (scripts/demo_sim.js): labeled wherever it is shown, never mixed with real data
    simulated: { type: Boolean, default: undefined },
    // Owner (the account that registered the device)
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    // A physical device can be registered only once; others get access through sharing
    deviceSerial: { type: String, required: true, unique: true },
    // How the camera is reached (platforms/): EZVIZ Open Platform (default), CamOS over AWS IoT
    // Core + the device API, or a KVS-only camera (live view, no snapshots)
    platform: { type: String, enum: PLATFORMS, default: 'ezviz' },
    device: { type: deviceSchema, default: undefined },
    // Registered by the public firmware itself (no owner until someone claims it on /claim).
    // Unclaimed cameras are hidden from every account (utils/ownership.js) and removed after 7 days
    selfRegistered: { type: Boolean, default: undefined },
    unclaimed: { type: Boolean, default: undefined },
    claimedAt: { type: Date, default: undefined },
    sharedWith: { type: [shareSchema], default: [] },
    // Paused by an admin (services/fleetService.js): no captures, uploads, live view or Sentinel actions;
    // the owner sees the reason. Unset = in service
    adminDisabled: {
        type: new mongoose.Schema({
            at: { type: Date, required: true },
            by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: undefined },
            reason: { type: String, default: '' }
        }, { _id: false }),
        default: undefined
    },
    // The owner's firmware choices (services/firmwareService.js)
    firmware: {
        // Install a new current release by itself, around autoHour (farm time)
        autoUpdate: { type: Boolean, default: undefined },
        autoHour: { type: Number, min: 0, max: 23, default: undefined },
        // The newest release the owner was told about (one notice per release)
        notifiedVersion: { type: String, default: undefined },
        // Release channel, set by an admin: alpha / beta test cameras take test releases (unset = stable)
        channel: { type: String, enum: ['alpha', 'beta', 'stable', null], default: undefined }
    },
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
    // 40x30 grey thumbnail of the latest photo (base64, 1200 bytes), to measure how much the next one changed.
    // Not selected by default: it never leaves the server
    qualityThumb: { type: String, default: undefined, select: false },
    // Last automatic or manual capture attempt for this device
    lastCaptureAt: { type: Date, default: null },
    // FlyBot Sentinel: a temporary capture interval that replaces captureIntervalMinutes until
    // `until` (services/captureSchedule.js), and the extra captures it asked for today
    sentinelInterval: {
        minutes: { type: Number, enum: [15, 30, 60, 120], default: undefined },
        until: { type: Date, default: undefined },
        setAt: { type: Date, default: undefined },
        reason: { type: String, default: undefined }
    },
    sentinelCaptures: {
        day: { type: String, default: undefined }, // farm day, YYYY-MM-DD
        count: { type: Number, default: undefined }
    },
    addedAt: { type: Date, default: Date.now },
    lastSync: { type: Date, default: Date.now }
});

cameraSchema.index({ 'sharedWith.userId': 1 });
cameraSchema.index({ 'sharedWith.email': 1 });

cameraSchema.index({ platform: 1 });
cameraSchema.index({ unclaimed: 1 }, { sparse: true });

const Camera = mongoose.model('Camera', cameraSchema);

module.exports = Camera;
module.exports.PLATFORMS = PLATFORMS;
