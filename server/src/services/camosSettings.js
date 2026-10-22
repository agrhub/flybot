/**
 * Settings of a camos-esp32-trap camera that FlyBot can change remotely (camos-esp32-trap docs/dev/CONFIG.md
 * section 6): the camera applies them from the desired document (camos/<serial>/shadow/desired) and reports the
 * applied values in shadow/reported. Network settings, the console password and anything the firmware answers
 * NOT_SUPPORTED are left out on purpose.
 *
 * Each field: path (dot path in the desired document), type (int | bool | enum | time | window | area), a range or
 * the values, and the section the settings form puts it in. The client renders its form from this list.
 */
const RESOLUTIONS = ['max', '640x480', '800x600', '1024x768', '1280x720', '1280x1024', '1600x1200', '1920x1080', '2048x1536', '2560x1920'];

const FIELDS = [
    // Capture
    { path: 'capture.intervalMin', section: 'capture', type: 'int', min: 1, max: 1440, nullable: true },
    { path: 'capture.window', section: 'capture', type: 'window', nullable: true },
    // "max" or a WxH the sensor takes; the list comes from the camera (reported camera.photoSizes) when it reports it
    { path: 'capture.resolution', section: 'capture', type: 'resolution', values: RESOLUTIONS },
    { path: 'capture.jpegQuality', section: 'capture', type: 'int', min: 1, max: 100 },
    // Picture
    { path: 'video.image.brightness', section: 'image', type: 'int', min: -64, max: 64 },
    { path: 'video.image.contrast', section: 'image', type: 'int', min: 0, max: 100 },
    { path: 'video.image.saturation', section: 'image', type: 'int', min: 0, max: 100 },
    { path: 'video.image.sharpness', section: 'image', type: 'int', min: 0, max: 100 },
    { path: 'video.image.vflip', section: 'image', type: 'bool' },
    { path: 'video.image.hmirror', section: 'image', type: 'bool' },
    { path: 'video.image.orientation', section: 'image', type: 'int', min: 0, max: 3 },
    { path: 'video.image.whiteBalance', section: 'image', type: 'enum', values: ['auto', 'sunny', 'cloudy', 'office', 'home'] },
    { path: 'video.image.effect', section: 'image', type: 'enum', values: ['none', 'negative', 'grayscale', 'red', 'green', 'blue', 'sepia'] },
    { path: 'video.image.aeLevel', section: 'image', type: 'int', min: -5, max: 5 },
    { path: 'video.image.exposureAuto', section: 'image', type: 'bool' },
    { path: 'video.image.exposure', section: 'image', type: 'int', min: 0, max: 1200 },
    { path: 'video.image.gainAuto', section: 'image', type: 'bool' },
    { path: 'video.image.gain', section: 'image', type: 'int', min: 0, max: 30 },
    { path: 'video.image.gainCeiling', section: 'image', type: 'int', min: 0, max: 6 },
    { path: 'video.image.denoise', section: 'image', type: 'int', min: 0, max: 8 },
    // Live view only: the sensor may stretch a frame up to 4x in a very dark place (slower, smears movement)
    { path: 'video.image.nightMode', section: 'image', type: 'bool' },
    // Motion
    { path: 'motion.enabled', section: 'motion', type: 'bool' },
    { path: 'motion.sensitivity', section: 'motion', type: 'int', min: 1, max: 100 },
    { path: 'motion.cooldownS', section: 'motion', type: 'int', min: 5, max: 3600 },
    { path: 'motion.upload', section: 'motion', type: 'bool' },
    { path: 'motion.saveSd', section: 'motion', type: 'bool' },
    { path: 'motion.area', section: 'motion', type: 'area' },
    // Power
    { path: 'power.mode', section: 'power', type: 'enum', values: ['auto', 'battery', 'powered'], nullable: true },
    { path: 'power.highMv', section: 'power', type: 'int', min: 3000, max: 4400 },
    { path: 'power.lowMv', section: 'power', type: 'int', min: 3000, max: 4400 },
    // Device
    { path: 'storage.sdSave', section: 'device', type: 'bool' },
    { path: 'led.enabled', section: 'device', type: 'bool' },
    { path: 'gps.enabled', section: 'device', type: 'bool' },
    { path: 'console.language', section: 'device', type: 'enum', values: ['en', 'vi'] },
];
const SECTIONS = ['capture', 'image', 'motion', 'power', 'device'];
const BY_PATH = new Map(FIELDS.map(f => [f.path, f]));
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function setPath(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    for (const k of keys.slice(0, -1)) {
        if (!o[k] || typeof o[k] !== 'object') o[k] = {};
        o = o[k];
    }
    o[keys.at(-1)] = value;
}

/** The value as the camera takes it, or { error } (type and range per the firmware's key list). */
function checkValue(field, value) {
    if (value === null) return field.nullable ? { value: null } : { error: 'not_nullable' };
    switch (field.type) {
        case 'int': {
            if (typeof value !== 'number' || !Number.isInteger(value)) return { error: 'not_integer' };
            if (value < field.min || value > field.max) return { error: 'out_of_range' };
            return { value };
        }
        case 'bool':
            return typeof value === 'boolean' ? { value } : { error: 'not_boolean' };
        case 'enum':
            return field.values.includes(value) ? { value } : { error: 'not_allowed' };
        case 'resolution':
            // The camera answers BAD_VALUE for a size its sensor cannot take
            return value === 'max' || (typeof value === 'string' && /^\d{3,4}x\d{3,4}$/.test(value)) ? { value } : { error: 'not_allowed' };
        case 'window': {
            if (!value || typeof value !== 'object' || !TIME.test(value.from) || !TIME.test(value.to)) return { error: 'bad_window' };
            if (value.from === value.to) return { error: 'bad_window' };
            return { value: { from: value.from, to: value.to } };
        }
        case 'area': {
            if (!Array.isArray(value) || value.length !== 4 || !value.every(n => Number.isInteger(n) && n >= 0 && n <= 100)) return { error: 'bad_area' };
            const [x, y, w, h] = value;
            if (w < 1 || h < 1 || x + w > 100 || y + h > 100) return { error: 'bad_area' };
            return { value: [x, y, w, h] };
        }
        default:
            return { error: 'unknown_type' };
    }
}

/**
 * A settings change from the form: { "capture.intervalMin": 30, "motion.enabled": true, ... } (flat paths) into
 * the nested desired document. Unknown paths and bad values are returned as errors and nothing is applied.
 */
function toDesired(changes) {
    const errors = [];
    const desired = {};
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return { errors: [{ path: '', error: 'bad_request' }], desired };
    const entries = Object.entries(changes);
    if (!entries.length) return { errors: [{ path: '', error: 'empty' }], desired };
    for (const [path, value] of entries) {
        const field = BY_PATH.get(path);
        if (!field) { errors.push({ path, error: 'unknown_setting' }); continue; }
        const checked = checkValue(field, value);
        if (checked.error) errors.push({ path, error: checked.error });
        else setPath(desired, path, checked.value);
    }
    return { errors, desired };
}

/**
 * What the form shows for a camera: for each field the value the camera reports (applied), the one FlyBot asked
 * for (desired), and whether it is still pending; plus the camera's own error list for the last document.
 */
function view(camera) {
    const reported = camera?.device?.shadow?.reported || {};
    const desired = camera?.device?.shadow?.desired || {};
    const values = {};
    for (const f of FIELDS) {
        const r = getPath(reported, f.path);
        const d = getPath(desired, f.path);
        values[f.path] = {
            reported: r === undefined ? null : r,
            desired: d === undefined ? null : d,
            pending: d !== undefined && JSON.stringify(d) !== JSON.stringify(r)
        };
    }
    // The photo sizes of this camera's sensor (camos-esp32-trap reports camera.photoSizes [[w, h], ...])
    const sizes = Array.isArray(reported.camera?.photoSizes) ? reported.camera.photoSizes.filter(s => Array.isArray(s) && Number.isInteger(s[0]) && Number.isInteger(s[1])) : [];
    const fields = sizes.length
        ? FIELDS.map(f => (f.path === 'capture.resolution' ? { ...f, values: ['max', ...sizes.map(([w, h]) => `${w}x${h}`)] } : f))
        : FIELDS;
    const cam = reported.camera && typeof reported.camera === 'object' ? reported.camera : null;
    return {
        sections: SECTIONS,
        fields,
        camera: cam ? { sensor: cam.sensor || null, maxW: cam.maxW || null, maxH: cam.maxH || null } : null,
        values,
        // Only the errors of fields this form changes: other desired keys (a sleeping camera's capture request, older
        // writes) are not the reader's settings, and a raw code there reads as a fault of the form
        errors: Array.isArray(reported.errors)
            ? reported.errors.filter(e => FIELDS.some(f => f.path === (e?.path || e?.key))).slice(0, 50)
            : [],
        reportedAt: camera?.device?.shadow?.reportedAt || null,
        fw: camera?.device?.fw || null,
        // The console's Device Information, as FlyBot last heard it (state and shadow reports)
        info: deviceInfo(camera, cam)
    };
}

/** Device Information of the console: identity, network, power and place, without SIM or modem identifiers. */
function deviceInfo(camera, cam) {
    const d = camera?.device || {};
    return {
        model: camera?.model || null,
        fw: d.fw || null,
        hw: d.hw || null,
        mac: d.mac || null,
        sensor: cam?.sensor || null,
        net: d.net || null,
        rssi: d.rssi ?? null,
        operator: d.operator || null,
        battery: d.battery || null,
        power: d.power?.mode || null,
        location: d.location || null,
        lastSeenAt: d.lastSeenAt || null,
        sleeping: !!d.sleeping
    };
}

/** Whether a desired path is one of the remote settings (the firmware applies it), e.g. video.image.brightness. */
const isField = (path) => FIELDS.some(f => f.path === path);

module.exports = { FIELDS, SECTIONS, checkValue, toDesired, view, isField };
