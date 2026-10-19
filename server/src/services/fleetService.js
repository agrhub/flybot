const { Camera, User, Farm, DeviceRegistry, Firmware, FirmwareUpdate } = require('../models');
const { OPEN_STATES } = require('../models/FirmwareUpdate');
const { maskCode } = require('./registryService');

/**
 * The admin's view of every camera (EZVIZ and CamOS): owner, state, place, serial, label code (masked), model,
 * hardware and firmware, the 4G modem's IMEI, last seen; and pausing a camera (Camera.adminDisabled).
 *
 * A paused camera takes no photo (cron, "Capture now", Sentinel), uploads nothing (device API answers 403
 * "disabled", never 401, which would make the camera drop its registration), opens no live view or SD playback,
 * and a CamOS camera gets `disabled: true` in its desired settings (firmware 0.7.0 and later stop by themselves).
 * Its photos and history stay readable; the owner sees the reason.
 */
const MAX_PAGE_SIZE = 100;
// A CamOS camera that said nothing for this long is offline (platforms/camos.js OFFLINE_AFTER_MS)
const OFFLINE_AFTER_MS = 2 * 60 * 60 * 1000;
const STATES = ['online', 'offline', 'sleeping', 'disabled', 'unclaimed'];
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isDisabled = (camera) => !!camera?.adminDisabled?.at;

/** Numeric compare of dotted versions ("0.10.0" > "0.9.3"); a pre-release suffix sorts before the release. */
function compareVersions(a, b) {
    const parse = (v) => {
        const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+(?:\.\d+)*)(?:[-+.]?(.*))?$/);
        return m ? { nums: m[1].split('.').map(Number), pre: m[2] || '' } : { nums: [], pre: String(v || '') };
    };
    const x = parse(a);
    const y = parse(b);
    for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
        const d = (x.nums[i] || 0) - (y.nums[i] || 0);
        if (d) return d > 0 ? 1 : -1;
    }
    if (x.pre === y.pre) return 0;
    if (!x.pre) return 1;
    if (!y.pre) return -1;
    return x.pre > y.pre ? 1 : -1;
}

/** online | offline | sleeping, the way the camera pages show it. */
function stateOf(camera, now = new Date()) {
    if ((camera.platform || 'ezviz') !== 'camos') return Number(camera.status) === 1 ? 'online' : 'offline';
    const d = camera.device || {};
    if (d.sleeping && (!d.wakeAt || new Date(d.wakeAt) > now)) return 'sleeping';
    const fresh = d.lastSeenAt && now.getTime() - new Date(d.lastSeenAt).getTime() <= OFFLINE_AFTER_MS;
    return Number(camera.status) === 1 && fresh ? 'online' : 'offline';
}

const firmwareOf = (camera) => ((camera.platform || 'ezviz') === 'camos' ? camera.device?.fw || '' : camera.deviceVersion || '');

/** The current release per model: Map model -> { version, id }. */
async function currentReleases() {
    const rows = await Firmware.find({ current: true }).select('model version').lean();
    return new Map(rows.map(r => [r.model, { version: r.version, id: String(r._id) }]));
}

function filterOf(query, owners) {
    const and = [{ simulated: { $ne: true } }];
    if (typeof query.q === 'string' && query.q.trim()) {
        const pattern = new RegExp(escapeRegex(query.q.trim().slice(0, 100)), 'i');
        and.push({ $or: [
            { deviceSerial: pattern }, { deviceName: pattern }, { locationAddress: pattern }, { model: pattern },
            { 'device.imei': pattern }, { 'device.iccid': pattern }, { userId: { $in: owners } }
        ] });
    }
    if (['ezviz', 'camos', 'kinesis'].includes(query.platform)) {
        and.push(query.platform === 'ezviz' ? { $or: [{ platform: 'ezviz' }, { platform: { $exists: false } }] } : { platform: query.platform });
    }
    if (typeof query.model === 'string' && query.model.trim()) and.push({ model: query.model.trim().slice(0, 64) });
    if (typeof query.fw === 'string' && query.fw.trim()) {
        const fw = query.fw.trim().slice(0, 40);
        and.push({ $or: [{ 'device.fw': fw }, { deviceVersion: fw }] });
    }
    if (query.state === 'disabled') and.push({ 'adminDisabled.at': { $exists: true } });
    if (query.state === 'unclaimed') and.push({ unclaimed: true });
    return { $and: and };
}

/**
 * GET /api/admin/fleet?q&platform&state&model&fw&outdated&page&limit. `state` online/offline/sleeping is worked out
 * per camera (it depends on the last message time), so those filters and `outdated` are applied after the query.
 */
async function list(query = {}, now = new Date()) {
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), MAX_PAGE_SIZE);
    let owners = [];
    if (typeof query.q === 'string' && query.q.trim()) {
        const pattern = new RegExp(escapeRegex(query.q.trim().slice(0, 100)), 'i');
        owners = (await User.find({ $or: [{ email: pattern }, { name: pattern }] }).select('_id').limit(500).lean()).map(u => u._id);
    }
    const filter = filterOf(query, owners);
    const releases = await currentReleases();
    const postFilter = ['online', 'offline', 'sleeping'].includes(query.state) || query.outdated === 'true' || query.outdated === '1';
    const select = 'deviceSerial deviceName platform model deviceVersion status validateCode userId farmId orgId latitude longitude locationAddress '
        + 'selfRegistered unclaimed adminDisabled addedAt lastCaptureAt lastSync sharedWith firmware '
        + 'device.fw device.net device.rssi device.battery device.power device.sleeping device.wakeAt device.lastSeenAt device.location '
        + 'device.imei device.iccid device.operator device.hw device.mac device.log device.lastCrash';
    let cameras;
    let total;
    if (postFilter) {
        // A fleet is a few thousand cameras at most: filter the computed fields in memory, then page
        const all = await Camera.find(filter).select(select).sort({ addedAt: -1 }).lean();
        cameras = all.filter(c => {
            if (['online', 'offline', 'sleeping'].includes(query.state) && (isDisabled(c) || stateOf(c, now) !== query.state)) return false;
            if (query.outdated === 'true' || query.outdated === '1') {
                const rel = releases.get(c.model);
                if (!rel || !firmwareOf(c) || compareVersions(firmwareOf(c), rel.version) >= 0) return false;
            }
            return true;
        });
        total = cameras.length;
        cameras = cameras.slice((page - 1) * limit, page * limit);
    } else {
        [total, cameras] = await Promise.all([
            Camera.countDocuments(filter),
            Camera.find(filter).select(select).sort({ addedAt: -1 }).skip((page - 1) * limit).limit(limit).lean()
        ]);
    }
    const serials = cameras.map(c => c.deviceSerial);
    const [users, farms, registry, updates, models] = await Promise.all([
        User.find({ _id: { $in: [...new Set(cameras.map(c => c.userId).filter(Boolean).map(String))] } }).select('email name').lean(),
        Farm.find({ _id: { $in: cameras.map(c => c.farmId).filter(Boolean) } }).select('name').lean(),
        DeviceRegistry.find({ serial: { $in: serials.map(s => s.toUpperCase()) } }).select('serial disabled batch hwVersion').lean(),
        FirmwareUpdate.find({ deviceSerial: { $in: serials }, state: { $in: OPEN_STATES } }).select('deviceSerial state toVersion waitReason progress').lean(),
        Camera.distinct('model', { simulated: { $ne: true } })
    ]);
    const userBy = new Map(users.map(u => [String(u._id), u]));
    const farmBy = new Map(farms.map(f => [String(f._id), f.name]));
    const regBy = new Map(registry.map(r => [r.serial, r]));
    const updBy = new Map(updates.map(u => [u.deviceSerial, u]));
    return {
        success: true,
        total,
        page,
        limit,
        models: models.filter(Boolean).sort(),
        cameras: cameras.map(c => rowOf(c, { userBy, farmBy, regBy, updBy, releases, now }))
    };
}

function rowOf(c, { userBy, farmBy, regBy, updBy, releases, now }) {
    const platform = c.platform || 'ezviz';
    const owner = c.userId ? userBy.get(String(c.userId)) : null;
    const reg = regBy.get(String(c.deviceSerial).toUpperCase());
    const fw = firmwareOf(c);
    const rel = platform === 'camos' ? releases.get(c.model) : null;
    const upd = updBy.get(c.deviceSerial);
    const d = c.device || {};
    return {
        deviceSerial: c.deviceSerial,
        deviceName: c.deviceName,
        platform,
        state: stateOf(c, now),
        disabled: isDisabled(c) ? { at: c.adminDisabled.at, reason: c.adminDisabled.reason || '' } : null,
        unclaimed: !!c.unclaimed,
        selfRegistered: !!c.selfRegistered,
        owner: owner ? { id: String(owner._id), email: owner.email, name: owner.name || '' } : null,
        sharedCount: (c.sharedWith || []).length,
        farm: c.farmId ? { id: String(c.farmId), name: farmBy.get(String(c.farmId)) || '' } : null,
        location: {
            lat: c.latitude ?? d.location?.lat ?? null,
            lng: c.longitude ?? d.location?.lng ?? null,
            address: c.locationAddress || ''
        },
        verifyCodeMasked: maskCode(c.validateCode),
        hasVerifyCode: !!c.validateCode,
        model: c.model || '',
        hw: d.hw || reg?.hwVersion || '',
        fw,
        latestFw: rel?.version || null,
        outdated: !!(rel && fw && compareVersions(fw, rel.version) < 0),
        autoUpdate: !!c.firmware?.autoUpdate,
        update: upd ? { state: upd.state, toVersion: upd.toVersion, waitReason: upd.waitReason || null, progress: upd.progress ?? null } : null,
        imei: d.imei || '',
        iccid: d.iccid || '',
        operator: d.operator || '',
        mac: d.mac || '',
        net: d.net || null,
        rssi: d.rssi ?? null,
        battery: d.battery || null,
        power: d.power?.mode || null,
        registry: reg ? { disabled: !!reg.disabled, batch: reg.batch || '' } : null,
        // Remote log on now, and how the last boot ended when it was not a normal restart
        logOn: !!d.log?.on && !!d.log?.until && new Date(d.log.until) > now,
        lastCrash: d.lastCrash?.at ? { at: d.lastCrash.at, reason: d.lastCrash.reason || '', fw: d.lastCrash.fw || '' } : null,
        lastSeenAt: platform === 'camos' ? d.lastSeenAt || null : c.lastSync || null,
        lastCaptureAt: c.lastCaptureAt || null,
        addedAt: c.addedAt || null
    };
}

/** POST /api/admin/fleet/:serial/reveal-code: the label code (audited by the controller). */
async function revealCode(serial) {
    const camera = await Camera.findOne({ deviceSerial: serial }).select('deviceSerial deviceName validateCode').lean();
    if (!camera) return { status: 404, body: { success: false, message: 'Camera not found.' } };
    return { status: 200, body: { success: true, deviceSerial: camera.deviceSerial, deviceName: camera.deviceName, verifyCode: camera.validateCode || '' } };
}

/**
 * PUT /api/admin/fleet/:serial/disabled { disabled, reason }: pause or resume a camera. The owner and the people it
 * is shared with are told. Returns { status, body }; body.changed false when nothing changed.
 */
async function setDisabled(serial, { disabled, reason }, actorId, now = new Date()) {
    if (typeof disabled !== 'boolean') return { status: 400, body: { success: false, message: 'disabled must be true or false.' } };
    const text = typeof reason === 'string' ? reason.trim().slice(0, 300) : '';
    const camera = await Camera.findOne({ deviceSerial: serial }).select('deviceSerial deviceName platform adminDisabled simulated').lean();
    if (!camera) return { status: 404, body: { success: false, message: 'Camera not found.' } };
    if (camera.simulated) return { status: 409, body: { success: false, code: 'SIMULATED_CAMERA', message: 'A simulated camera cannot be paused.' } };
    const was = isDisabled(camera);
    if (disabled) {
        await Camera.updateMany({ deviceSerial: serial }, { $set: { adminDisabled: { at: was ? camera.adminDisabled.at : now, by: actorId, reason: text } } });
    } else {
        await Camera.updateMany({ deviceSerial: serial }, { $unset: { adminDisabled: 1 } });
    }
    if (was === disabled && (!disabled || text === (camera.adminDisabled?.reason || ''))) {
        return { status: 200, body: { success: true, changed: false, disabled } };
    }
    // CamOS: the camera stops by itself (firmware 0.7.0+); older firmware answers NOT_SUPPORTED and FlyBot still
    // refuses its uploads and live view
    let deviceSynced = null;
    if ((camera.platform || 'ezviz') === 'camos') {
        deviceSynced = await require('../platforms/camos').updateDesired(serial, { disabled })
            .then(() => true, err => { console.warn(`⚠️ Disabled flag not sent to ${serial}: ${err.message}`); return false; });
        if (disabled) require('../platforms/camos').rpc(serial, 'live.stop', {}).catch(() => {});
    }
    if (was !== disabled) {
        const notifications = require('./notificationService');
        notifications.notifyCameraOwners(serial, disabled ? 'camera_disabled' : 'camera_enabled', (cam) => ({ camera: cam.deviceName || cam.deviceSerial, reason: text }))
            .catch(err => console.warn(`⚠️ Pause notice for ${serial} failed: ${err.message}`));
    }
    return { status: 200, body: { success: true, changed: true, disabled, deviceSynced } };
}

/** Is this serial paused? (device API, capture) */
async function serialDisabled(serial) {
    return !!(await Camera.exists({ deviceSerial: serial, 'adminDisabled.at': { $exists: true } }));
}

module.exports = {
    STATES,
    isDisabled,
    compareVersions,
    stateOf,
    firmwareOf,
    currentReleases,
    list,
    revealCode,
    setDisabled,
    serialDisabled
};
