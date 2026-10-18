const env = require('../config/env');

/**
 * Clock and timezone for the CamOS cameras (flybot-aws CONTRACTS 2a.6): GET /api/device/time and
 * the shadow's `tz`. The timezone is chosen in this order:
 *   1. farm    the timezone of the camera's farm (or, for a camera without a farm, the owner's
 *              only farm that has one)
 *   2. gps     the camera's last GPS fix, looked up offline (@photostructure/tz-lookup, CC0)
 *   3. ip      the request's public address -> country (ip3country, IP2Location LITE data,
 *              CC BY-SA 4.0) -> the country's main timezone (countries-and-timezones)
 *   4. default DEVICE_DEFAULT_TIMEZONE (Asia/Ho_Chi_Minh)
 * Nothing calls an outside service. `posix` is the POSIX TZ string ESP-IDF's setenv("TZ") needs,
 * from the bundled table (data/posixTz.json, made by scripts/build_posix_tz.js from Node's own
 * timezone data) or computed the same way for a zone the table lacks.
 */
const POSIX_TABLE = require('../data/posixTz.json');

// ---------- IANA -> POSIX ----------

const isZone = (zone) => {
    if (typeof zone !== 'string' || !zone || zone.length > 64) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        return true;
    } catch {
        return false;
    }
};

const offsetFormatters = new Map();
/** The zone's UTC offset in minutes at `date` (east positive). */
function offsetMinutes(zone, date) {
    if (!offsetFormatters.has(zone)) offsetFormatters.set(zone, new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }));
    const name = offsetFormatters.get(zone).formatToParts(date).find(p => p.type === 'timeZoneName')?.value || 'GMT';
    const m = name.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
    if (!m) return 0;
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

const pad2 = (n) => String(n).padStart(2, '0');
/** "<+07>" / "<-0330>" (the quoted numeric form newlib accepts for any zone). */
function abbreviation(minutes) {
    const sign = minutes < 0 ? '-' : '+';
    const abs = Math.abs(minutes);
    return `<${sign}${pad2(Math.floor(abs / 60))}${abs % 60 ? pad2(abs % 60) : ''}>`;
}
/** POSIX offset: west positive ("-7" for UTC+7, "3:30" for UTC-3:30). */
function posixOffset(minutes) {
    const west = -minutes;
    const abs = Math.abs(west);
    return `${west < 0 ? '-' : ''}${Math.floor(abs / 60)}${abs % 60 ? `:${pad2(abs % 60)}` : ''}`;
}

/** The instants in `year` where the zone's offset changes, to the minute. */
function transitions(zone, year) {
    const out = [];
    const day = 24 * 3600 * 1000;
    let t = Date.UTC(year, 0, 1);
    const end = Date.UTC(year + 1, 0, 1);
    let prev = offsetMinutes(zone, new Date(t));
    for (t += day; t <= end; t += day) {
        const cur = offsetMinutes(zone, new Date(t));
        if (cur !== prev) {
            let lo = t - day;
            let hi = t;
            while (hi - lo > 60 * 1000) {
                const mid = Math.floor((lo + hi) / 2 / 60000) * 60000;
                if (offsetMinutes(zone, new Date(mid)) === prev) lo = mid; else hi = mid;
            }
            out.push({ at: hi, from: prev, to: cur });
            prev = cur;
        }
    }
    return out;
}

/** "Mm.w.d/h[:mm]" for a transition, in the wall time that was in force just before it. */
function rule(tr) {
    const local = new Date(tr.at + tr.from * 60 * 1000);
    const month = local.getUTCMonth() + 1;
    const date = local.getUTCDate();
    const daysInMonth = new Date(Date.UTC(local.getUTCFullYear(), month, 0)).getUTCDate();
    const week = date + 7 > daysInMonth ? 5 : Math.ceil(date / 7);
    const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
    const time = `${Math.floor(minutes / 60)}${minutes % 60 ? `:${pad2(minutes % 60)}` : ''}`;
    return `M${month}.${week}.${local.getUTCDay()}/${time}`;
}

/** The POSIX TZ string of an IANA zone from Node's timezone data (the rules of `year`). */
function computePosix(zone, year = new Date().getUTCFullYear()) {
    if (!isZone(zone)) return null;
    const trs = transitions(zone, year);
    if (trs.length !== 2) {
        const offset = offsetMinutes(zone, new Date(Date.UTC(year, 6, 1)));
        return `${abbreviation(offset)}${posixOffset(offset)}`;
    }
    // Standard time = the smaller offset; DST starts at the move to the larger one
    const start = trs.find(t => t.to > t.from);
    const stop = trs.find(t => t.to < t.from);
    if (!start || !stop) {
        const offset = offsetMinutes(zone, new Date(Date.UTC(year, 0, 1)));
        return `${abbreviation(offset)}${posixOffset(offset)}`;
    }
    const std = start.from;
    const dst = start.to;
    const dstOffset = dst - std === 60 ? '' : posixOffset(dst);
    return `${abbreviation(std)}${posixOffset(std)}${abbreviation(dst)}${dstOffset},${rule(start)},${rule(stop)}`;
}

function posixOf(zone) {
    return POSIX_TABLE[zone] || computePosix(zone) || POSIX_TABLE[env.DEVICE_DEFAULT_TIMEZONE] || '<+07>-7';
}

// ---------- Sources ----------

/** Timezone of a GPS fix, or null. */
function zoneOfLocation(location) {
    const lat = Number(location?.lat);
    const lng = Number(location?.lng ?? location?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    if (lat === 0 && lng === 0) return null; // no fix
    try {
        const zone = require('@photostructure/tz-lookup')(lat, lng);
        return isZone(zone) ? zone : null;
    } catch {
        return null;
    }
}

// Countries with several zones: the one most people live in
const COUNTRY_ZONE = {
    US: 'America/New_York', CA: 'America/Toronto', MX: 'America/Mexico_City', BR: 'America/Sao_Paulo',
    AR: 'America/Argentina/Buenos_Aires', CL: 'America/Santiago', EC: 'America/Guayaquil', RU: 'Europe/Moscow',
    UA: 'Europe/Kyiv', KZ: 'Asia/Almaty', UZ: 'Asia/Tashkent', CN: 'Asia/Shanghai', MN: 'Asia/Ulaanbaatar',
    ID: 'Asia/Jakarta', MY: 'Asia/Kuala_Lumpur', AU: 'Australia/Sydney', NZ: 'Pacific/Auckland',
    CD: 'Africa/Kinshasa', DE: 'Europe/Berlin', ES: 'Europe/Madrid', PT: 'Europe/Lisbon', FR: 'Europe/Paris',
    GB: 'Europe/London', IN: 'Asia/Kolkata', VN: 'Asia/Ho_Chi_Minh', TH: 'Asia/Bangkok', PH: 'Asia/Manila'
};

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^0\./];
/** The client's public IPv4/IPv6 address as Express saw it ("::ffff:" removed), or null. */
function publicIpOf(ip) {
    let value = String(ip || '').trim();
    if (value.startsWith('::ffff:')) value = value.slice(7);
    if (!value || value.length > 45) return null;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return PRIVATE_V4.some(r => r.test(value)) ? null : value;
    if (value.includes(':')) return /^(::1?|f[cd]|fe80)/i.test(value) ? null : value;
    return null;
}

let ip3Ready = false;
/** Country code of a public IPv4 address (offline), or null. */
function countryOfIp(ip) {
    if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
    try {
        const ip3 = require('ip3country');
        if (!ip3Ready) {
            ip3.init();
            ip3Ready = true;
        }
        const cc = ip3.lookupStr(ip);
        return typeof cc === 'string' && /^[A-Z]{2}$/.test(cc) ? cc : null;
    } catch {
        return null;
    }
}

/** The main timezone of a country, or null. */
function zoneOfCountry(cc) {
    if (!cc) return null;
    if (COUNTRY_ZONE[cc] && isZone(COUNTRY_ZONE[cc])) return COUNTRY_ZONE[cc];
    try {
        const ct = require('countries-and-timezones');
        const country = ct.getCountry(cc);
        if (!country) return null;
        const own = country.timezones.filter(z => ct.getTimezone(z)?.countries?.[0] === cc && isZone(z));
        const zone = own[0] || country.timezones.find(isZone);
        return zone || null;
    } catch {
        return null;
    }
}

/** The farm timezone that applies to a camera, or null. */
async function farmZoneOf(camera) {
    const { Farm } = require('../models');
    if (camera?.farmId) {
        const farm = await Farm.findById(camera.farmId).select('timezone').lean();
        if (isZone(farm?.timezone)) return farm.timezone;
    }
    if (camera?.userId && !camera.unclaimed) {
        const zones = [...new Set((await Farm.find({ ownerId: camera.userId, timezone: { $nin: ['', null] } }).select('timezone').limit(5).lean())
            .map(f => f.timezone).filter(isZone))];
        if (zones.length === 1) return zones[0];
    }
    return null;
}

function locationOf(camera) {
    const loc = camera?.device?.location;
    if (loc && Number.isFinite(Number(loc.lat))) return loc;
    if (Number.isFinite(camera?.latitude) && Number.isFinite(camera?.longitude)) return { lat: camera.latitude, lng: camera.longitude };
    return null;
}

/**
 * The timezone for a camera (may be null: an unknown camera) and/or a request IP.
 * Returns { timezone, posix, tzSource: farm | gps | ip | default }.
 */
async function resolve({ camera = null, ip = null } = {}) {
    let timezone = null;
    let tzSource = 'default';
    if (camera) {
        timezone = await farmZoneOf(camera);
        if (timezone) tzSource = 'farm';
        if (!timezone) {
            timezone = zoneOfLocation(locationOf(camera));
            if (timezone) tzSource = 'gps';
        }
    }
    if (!timezone) {
        timezone = zoneOfCountry(countryOfIp(publicIpOf(ip)));
        if (timezone) tzSource = 'ip';
    }
    if (!timezone) {
        timezone = isZone(env.DEVICE_DEFAULT_TIMEZONE) ? env.DEVICE_DEFAULT_TIMEZONE : 'Asia/Ho_Chi_Minh';
        tzSource = 'default';
    }
    return { timezone, posix: posixOf(timezone), tzSource };
}

/** GET /api/device/time: { now, epoch, timezone, posix, tzSource, publicIp }. */
async function deviceTime({ camera = null, ip = null, now = new Date() } = {}) {
    const zone = await resolve({ camera, ip });
    return {
        now: now.toISOString(),
        epoch: Math.floor(now.getTime() / 1000),
        timezone: zone.timezone,
        posix: zone.posix,
        tzSource: zone.tzSource,
        publicIp: publicIpOf(ip)
    };
}

/**
 * Keep a CamOS camera's shadow `tz` in step with its timezone (after a claim, a farm change or a
 * GPS fix in another zone). Only a farm or GPS answer is written (an IP guess is per request);
 * nothing is sent when the zone did not change. Returns { changed, timezone, posix, tzSource }.
 */
async function syncCamera(deviceSerial) {
    const { Camera } = require('../models');
    const camera = await Camera.findOne({ deviceSerial, platform: 'camos' }).lean();
    if (!camera) return { changed: false };
    const zone = await resolve({ camera });
    if (zone.tzSource !== 'farm' && zone.tzSource !== 'gps') return { changed: false, ...zone };
    const current = camera.device?.tz;
    if (current?.iana === zone.timezone && current?.posix === zone.posix) return { changed: false, ...zone };
    await Camera.updateMany({ deviceSerial }, { $set: { 'device.tz': { iana: zone.timezone, posix: zone.posix, source: zone.tzSource, at: new Date() } } });
    try {
        // tz for the AMB82 firmware, timezone (IANA) for camos-esp32-trap
        await require('../platforms/camos').updateDesired(deviceSerial, { tz: { iana: zone.timezone, posix: zone.posix }, timezone: zone.timezone });
    } catch (err) {
        console.warn(`⚠️ Shadow tz not updated (${deviceSerial}): ${err.message}`);
    }
    return { changed: true, ...zone };
}

/** syncCamera for every CamOS camera of a farm (its timezone changed). */
async function syncFarm(farmId) {
    const { Camera } = require('../models');
    const cameras = await Camera.find({ farmId, platform: 'camos' }).select('deviceSerial').lean();
    let changed = 0;
    for (const c of cameras) {
        if ((await syncCamera(c.deviceSerial).catch(() => ({}))).changed) changed++;
    }
    return { cameras: cameras.length, changed };
}

module.exports = {
    isZone,
    computePosix,
    posixOf,
    zoneOfLocation,
    publicIpOf,
    countryOfIp,
    zoneOfCountry,
    resolve,
    deviceTime,
    syncCamera,
    syncFarm
};
