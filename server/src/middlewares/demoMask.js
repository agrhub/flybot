/**
 * What visitors may not see of a shared demo camera (services/demoView.js), taken out of every
 * answer of their requests, so no page or endpoint has to remember it:
 *  - serial hidden: every text of the answer (JSON, text, server-sent events, file names) shows
 *    the camera's alias instead, and requests that use the alias (links, photo URLs, the assistant)
 *    reach the camera again (unaliasRequest). The player of live view and recorded video still
 *    gets the real serial (EZVIZ and KVS need it), so those answers keep it (res.locals.demoRawSerial);
 *  - location or device details closed: those fields are dropped from every object that names the
 *    camera (deviceSerial, serial, ...) and from what it holds, and from the whole answer of a
 *    request about that camera (/cameras/:serial/..., deviceSerial in the body or query).
 * The controllers check the same permissions first (utils/ownership.js); this is the net under them.
 */

// Keys that name the camera an object is about
const SERIAL_KEYS = ['deviceSerial', 'serial', 'device_id', 'deviceId', 'camera_id', 'cameraSerial', 'camera'];
// The position: map, address, GPS fix, cell estimate, and the shadow (it can hold them too)
const LOCATION_KEYS = new Set([
    'latitude', 'longitude', 'lat', 'lng', 'lon', 'locationAddress', 'address', 'location', 'gps', 'coordinates', 'cell',
    'reported', 'desired', 'shadow'
]);
// The device details: status bar, battery, signal, network, firmware, modem, log
const DEVICE_KEYS = new Set([
    'fw', 'firmware', 'deviceVersion', 'net', 'rssi', 'battery', 'battery_percent', 'power', 'power_mode',
    'telemetry', 'telemetry_at', 'telemetry_history', 'reported', 'desired', 'shadow', 'reported_version', 'desired_version',
    'imei', 'iccid', 'operator', 'mac', 'hw', 'sensor', 'localUrl', 'kvsChannelName', 'thingName',
    'paired', 'pairedAt', 'provisionExpiresAt', 'lastCrash', 'log', 'deviceType'
]);

// The restrictions of a camera named by its serial or its alias (null: none)
const permsOf = (mask, serial) => mask.perms.get(serial) || mask.perms.get(mask.byAlias?.get(serial)) || null;

/**
 * The permissions of the camera this object names: its restrictions, null when it names another
 * camera (nothing withheld), undefined when it names none (it keeps its parent's).
 */
function namedPerms(obj, mask) {
    for (const key of SERIAL_KEYS) {
        const value = obj[key];
        if (typeof value !== 'string') continue;
        return permsOf(mask, value);
    }
    return undefined;
}

/** Plain JSON data without the withheld fields. `perms`: the restrictions in force here. */
function scrub(value, mask, perms = null) {
    if (Array.isArray(value)) return value.map(v => scrub(v, mask, perms));
    if (!value || typeof value !== 'object') return value;
    const named = namedPerms(value, mask);
    const p = named === undefined ? perms : named;
    const out = {};
    for (const [key, v] of Object.entries(value)) {
        // The camera's own permissions (toClientCamera's demo) are not its location or device
        if (key === 'demo' && named) {
            out[key] = v;
            continue;
        }
        if (p && !p.location && LOCATION_KEYS.has(key)) continue;
        if (p && !p.device && DEVICE_KEYS.has(key)) continue;
        out[key] = scrub(v, mask, p);
    }
    return out;
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every way a hidden serial is written -> its alias: the serial itself and, for an ESP32 trap
 * (ESP + MAC), its MAC address with or without colons.
 */
function spellings(mask) {
    if (mask.spellings) return mask.spellings;
    const pairs = [];
    for (const [serial, alias] of mask.aliases) {
        pairs.push([serial, alias]);
        const mac = /^ESP([0-9A-F]{12})$/i.exec(serial)?.[1];
        if (mac) {
            const colons = mac.match(/../g).join(':');
            for (const form of new Set([mac.toLowerCase(), mac.toUpperCase(), colons.toLowerCase(), colons.toUpperCase()])) pairs.push([form, alias]);
        }
    }
    // Longest first, so a serial inside a longer one is not cut
    pairs.sort((a, b) => b[0].length - a[0].length);
    mask.spellings = pairs.length ? { regex: new RegExp(pairs.map(([s]) => escapeRegex(s)).join('|'), 'g'), to: new Map(pairs) } : null;
    return mask.spellings;
}

/** The text with every hidden serial replaced by its alias. */
function aliasText(text, mask) {
    const found = mask && typeof text === 'string' ? spellings(mask) : null;
    return found ? text.replace(found.regex, (s) => found.to.get(s)) : text;
}

/** Plain data for a visitor: withheld fields dropped, hidden serials aliased (the assistant's tool results). */
function maskData(value, mask, rootSerial = null) {
    if (!mask || value === undefined) return value;
    const plain = JSON.parse(JSON.stringify(value));
    const root = rootSerial ? permsOf(mask, rootSerial) : null;
    return JSON.parse(aliasText(JSON.stringify(scrub(plain, mask, root)), mask));
}

// Every string of the value, also object keys, through `fn`
function mapStrings(value, fn) {
    if (typeof value === 'string') return fn(value);
    if (Array.isArray(value)) return value.map(v => mapStrings(v, fn));
    if (!value || typeof value !== 'object' || value instanceof Date) return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [fn(k), mapStrings(v, fn)]));
}

/** Aliases -> serials in any value (the assistant's tool arguments). */
function unaliasData(value, serialsByAlias) {
    if (!serialsByAlias?.size) return value;
    const regex = /DEMO-[0-9A-F]{10}/g;
    return mapStrings(value, (s) => (s.includes('DEMO-') ? s.replace(regex, (a) => serialsByAlias.get(a) || a) : s));
}

/** The camera a request is about: /cameras/:serial/..., or deviceSerial in the body or query. */
function requestSerial(req) {
    const fromPath = /\/cameras\/([A-Za-z0-9_-]{1,64})(?:\/|$)/.exec(String(req.originalUrl || '').split('?')[0])?.[1];
    const fromBody = typeof req.body?.deviceSerial === 'string' ? req.body.deviceSerial : null;
    let fromQuery = null;
    try {
        fromQuery = typeof req.query?.deviceSerial === 'string' ? req.query.deviceSerial : null;
    } catch {
        // No query parser on this request
    }
    return req.params?.serial || fromPath || fromBody || fromQuery || null;
}

/**
 * Take the withheld parts out of everything this response sends (middlewares/auth.js calls it for
 * a visitor with a mask from services/demoView.js maskFor).
 */
function maskResponse(req, res, mask) {
    if (!mask) return;
    const json = res.json.bind(res);
    res.json = (body) => {
        if (!body || typeof body !== 'object') return json(body);
        const root = permsOf(mask, requestSerial(req));
        return json(scrub(JSON.parse(JSON.stringify(body)), mask, root));
    };
    if (!mask.aliases.size) return;
    const raw = () => !!res.locals.demoRawSerial;
    const send = res.send.bind(res);
    res.send = (body) => send(typeof body === 'string' && !raw() ? aliasText(body, mask) : body);
    const write = res.write.bind(res);
    res.write = (chunk, ...rest) => write(typeof chunk === 'string' && !raw() ? aliasText(chunk, mask) : chunk, ...rest);
    const setHeader = res.setHeader.bind(res);
    res.setHeader = (name, value) => setHeader(name, String(name).toLowerCase() === 'content-disposition' ? aliasText(String(value), mask) : value);
}

/**
 * Requests that use an alias (links, photo URLs, forms) reach the real camera: the alias in the
 * path, query and body becomes the serial before any route runs. Who may then see the camera is
 * decided as always (utils/ownership.js); the alias alone opens nothing.
 */
async function unaliasRequest(req, res, next) {
    try {
        const inUrl = String(req.url || '').includes('DEMO-');
        const inBody = !!req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) && JSON.stringify(req.body).includes('DEMO-');
        if (!inUrl && !inBody) return next();
        const settings = await require('../services/settingsService').getSettings();
        const serials = require('../services/demoView').serialsByAlias(settings);
        if (!serials.size) return next();
        const regex = /DEMO-[0-9A-F]{10}/g;
        const swap = (s) => s.replace(regex, (a) => serials.get(a) || a);
        if (inUrl) {
            req.url = swap(req.url);
            req.originalUrl = swap(String(req.originalUrl || ''));
        }
        if (inBody) req.body = unaliasData(req.body, serials);
    } catch (err) {
        console.warn('⚠️ Demo alias not resolved:', err.message);
    }
    return next();
}

module.exports = {
    scrub,
    aliasText,
    maskData,
    unaliasData,
    requestSerial,
    maskResponse,
    unaliasRequest
};
