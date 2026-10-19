/**
 * The simulated demo farm's world (services/demoSim.js): farms across Vietnam's fruit regions,
 * their plots and traps, and the fly level every trap would see each day. Pure functions only, so
 * the seed and the daily job compute exactly the same plan.
 *
 * Everything here is made up for the demo: farm-level points near district centres (not real
 * farms), plausible crops and trap kinds, and a seasonal wave per region. The photos are labeled
 * synthetic pictures; the counts FlyBot stores come from the real vision pipeline on them.
 */
const TZ_OFFSET_MS = 7 * 3600 * 1000; // Asia/Ho_Chi_Minh, no daylight saving
const DAY_MS = 24 * 3600 * 1000;

// The simulation starts here (the first day of the synthetic photo set)
const START_DAY = '2026-09-19';

// Each region's fly wave: base flies a photo, wave height, peak day of year and width (days)
const REGIONS = {
    mekong: { base: 4, amp: 22, peak: 300, width: 28 },
    southeast: { base: 3, amp: 18, peak: 285, width: 25 },
    highlands: { base: 3, amp: 16, peak: 262, width: 30 },
    central: { base: 2, amp: 14, peak: 318, width: 22 },
    north: { base: 1, amp: 4, peak: 225, width: 35 }
};

const SHOWCASE = 'SHOW';

/**
 * Farms: key, name, province, region, crop, centre. Each farm has two plots of two traps (one
 * sticky card and lure traps, as growers mix them); the showcase farm holds the four traps of the
 * synthetic photo set.
 */
const FARMS = [
    { key: 'CAIBE', name: 'Vườn xoài Cái Bè', province: 'Tiền Giang', region: 'mekong', crop: 'Xoài cát Hòa Lộc', lat: 10.3390, lng: 106.0320 },
    { key: 'CHOLACH', name: 'Vườn bưởi Chợ Lách', province: 'Bến Tre', region: 'mekong', crop: 'Bưởi da xanh', lat: 10.2620, lng: 106.1330 },
    { key: 'CAOLANH', name: 'Vườn xoài Cao Lãnh', province: 'Đồng Tháp', region: 'mekong', crop: 'Xoài', lat: 10.4600, lng: 105.6330 },
    { key: 'HAMTHUAN', name: 'Vườn thanh long Hàm Thuận Bắc', province: 'Bình Thuận', region: 'southeast', crop: 'Thanh long ruột đỏ', lat: 11.0800, lng: 108.0700 },
    { key: 'LONGKHANH', name: 'Vườn chôm chôm Long Khánh', province: 'Đồng Nai', region: 'southeast', crop: 'Chôm chôm', lat: 10.9300, lng: 107.2400 },
    { key: 'KRONGPAC', name: 'Vườn sầu riêng Krông Pắc', province: 'Đắk Lắk', region: 'highlands', crop: 'Sầu riêng', lat: 12.7000, lng: 108.3000 },
    { key: 'CAMLAM', name: 'Vườn xoài Cam Lâm', province: 'Khánh Hòa', region: 'central', crop: 'Xoài Úc', lat: 12.0800, lng: 109.1000 },
    { key: 'KHOAICHAU', name: 'Vườn nhãn Khoái Châu', province: 'Hưng Yên', region: 'north', crop: 'Nhãn lồng', lat: 20.8400, lng: 105.9700 },
    { key: 'LUCNGAN', name: 'Vườn vải Lục Ngạn', province: 'Bắc Giang', region: 'north', crop: 'Vải thiều', lat: 21.3800, lng: 106.5800 }
];

// The showcase farm: the synthetic set's four traps keep their own ids and points
const SHOWCASE_FARM = { key: SHOWCASE, name: 'Vườn trình diễn', province: 'Bình Dương', region: 'southeast', crop: 'Xoài', lat: 11.1502, lng: 106.4003 };

// Photos a day of the nationwide traps (local time); the showcase traps use their set's slots
const NATIONAL_SLOTS = ['07:00', '15:30'];
const SHOWCASE_SLOTS = ['06:30', '09:00', '11:30', '14:00', '16:30'];

// ---------- Deterministic randomness ----------

function hashOf(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/** A number in [0, 1) fixed by the key. */
const rand = (key) => {
    let t = hashOf(String(key)) + 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ---------- Days ----------

/** 'YYYY-MM-DD' of a date in farm time. */
const dayKeyOf = (date) => new Date(new Date(date).getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);
/** The instant of a local day and 'HH:MM'. */
const at = (dayKey, hhmm) => new Date(`${dayKey}T${hhmm}:00+07:00`);
const addDays = (dayKey, n) => new Date(new Date(`${dayKey}T12:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);
const dayIndex = (dayKey) => Math.round((new Date(`${dayKey}T12:00:00Z`) - new Date(`${START_DAY}T12:00:00Z`)) / DAY_MS);
const dayOfYear = (dayKey) => Math.round((new Date(`${dayKey}T12:00:00Z`) - new Date(`${dayKey.slice(0, 4)}-01-01T12:00:00Z`)) / DAY_MS) + 1;

/** The days from START_DAY to the day of `until` (both included). */
function daysUntil(until) {
    const last = dayKeyOf(until);
    const out = [];
    for (let d = START_DAY; d <= last; d = addDays(d, 1)) out.push(d);
    return out;
}

// ---------- Farms, plots, traps ----------

/** A small plot rectangle (about 120 x 90 m) south-east of a point, as [lat, lng] vertices. */
function boundaryAround(lat, lng) {
    const dLat = 0.0008;
    const dLng = 0.0011;
    return [[lat, lng], [lat, lng + dLng], [lat - dLat, lng + dLng], [lat - dLat, lng]];
}

/**
 * The world: farms with their plots and traps. Trap serials are SIM-<FARM>-<n>; the showcase
 * traps map the synthetic set's trap ids (manifest traps[]) to SIM-SHOW-<A..D>.
 */
function buildWorld(showcaseTraps = []) {
    const farms = FARMS.map((farm) => {
        const plots = [0, 1].map((p) => {
            const lat = farm.lat + (p ? -0.0012 : 0);
            const lng = farm.lng + (p ? 0.0004 : 0);
            const traps = [0, 1].map((t) => {
                const n = p * 2 + t + 1;
                // Each farm keeps one sticky card (on its first plot) beside its lure traps
                const kind = p === 0 && t === 0 ? 'sticky' : 'lure';
                return {
                    serial: `SIM-${farm.key}-${n}`,
                    name: `SIM · ${farm.name.replace(/^Vườn /, '')} ${n}`,
                    kind,
                    lat: lat - 0.0003 - t * 0.0003,
                    lng: lng + 0.0003 + t * 0.0005,
                    factor: 0.7 + rand(`factor:${farm.key}:${n}`) * 0.6
                };
            });
            return { key: `${farm.key}-${p + 1}`, name: `Lô ${String.fromCharCode(65 + p)}`, crop: farm.crop, boundary: boundaryAround(lat, lng), traps };
        });
        return { ...farm, plots, showcase: false };
    });
    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    const showTraps = showcaseTraps.slice(0, letters.length).map((t, i) => ({
        serial: `SIM-${SHOWCASE}-${letters[i]}`,
        name: `SIM · Trình diễn ${letters[i]}`,
        kind: t.trapKind === 'sticky' ? 'sticky' : 'lure',
        lat: Number.isFinite(t.lat) ? t.lat : SHOWCASE_FARM.lat - i * 0.0003,
        lng: Number.isFinite(t.lon) ? t.lon : SHOWCASE_FARM.lng + i * 0.0003,
        factor: 1,
        setTrap: t.id
    }));
    if (showTraps.length) {
        farms.unshift({
            ...SHOWCASE_FARM,
            showcase: true,
            plots: [{ key: `${SHOWCASE}-1`, name: 'Lô trình diễn', crop: SHOWCASE_FARM.crop, boundary: boundaryAround(SHOWCASE_FARM.lat + 0.0004, SHOWCASE_FARM.lng - 0.0004), traps: showTraps }]
        });
    }
    return farms;
}

const trapsOf = (farms) => farms.flatMap(f => f.plots.flatMap(p => p.traps.map(t => ({ ...t, farm: f, plot: p }))));

// ---------- Fly levels and the field log ----------

/**
 * The seasonal level (flies a lure photo) on a day, before treatments: the region's wave, shifted
 * by up to a week and scaled per farm (`farmKey`) so neighbouring farms do not move in step.
 */
function seasonal(region, dayKey, farmKey = '') {
    const r = REGIONS[region] || REGIONS.mekong;
    const shift = farmKey ? Math.round((rand(`shift:${farmKey}`) - 0.5) * 14) : 0;
    const scale = farmKey ? 0.8 + rand(`scale:${farmKey}`) * 0.4 : 1;
    const doy = dayOfYear(dayKey);
    const dist = Math.min(Math.abs(doy - r.peak - shift), 365 - Math.abs(doy - r.peak - shift));
    return (r.base + r.amp * Math.exp(-(dist * dist) / (2 * r.width * r.width))) * scale;
}

// What a treatment does: share of flies removed at once, and how fast the effect fades (days)
const EFFECTS = {
    spray: { drop: 0.6, tau: 5 },
    bait: { drop: 0.5, tau: 6 },
    biological: { drop: 0.3, tau: 12 },
    sanitation: { drop: 0.2, tau: 8 }
};

/** Multiplier on a day from the treatments before it (by index). */
function treatmentFactor(treatments, index) {
    let factor = 1;
    for (const t of treatments) {
        const d = index - t.index;
        if (d < 0) continue;
        const e = EFFECTS[t.type] || EFFECTS.spray;
        factor *= 1 - e.drop * Math.exp(-d / e.tau);
    }
    return factor;
}

// The farm's alert level: more than this many flies a lure photo calls for action
const ACTION_LEVEL = 14;

/**
 * The farm's field log from START_DAY to lastDay: sprays or baits when the level stays high (at
 * most every 10 days), a natural-enemy release after the second one, and fallen-fruit sanitation
 * every two weeks in the wave. Same answer every time for the same farm.
 */
function fieldLogOf(farm, lastDay) {
    const days = [];
    for (let d = START_DAY; d <= lastDay; d = addDays(d, 1)) days.push(d);
    const treatments = [];
    let lastAction = -99;
    let lastSanitation = -99;
    let actions = 0;
    days.forEach((dayKey, index) => {
        const level = seasonal(farm.region, dayKey, farm.key) * treatmentFactor(treatments, index);
        if (level > ACTION_LEVEL && index - lastAction >= 10) {
            actions += 1;
            const type = actions % 3 === 0 ? 'biological' : (actions % 2 === 0 ? 'bait' : 'spray');
            treatments.push({ index, day: dayKey, type, hhmm: '06:00' });
            lastAction = index;
        } else if (level > ACTION_LEVEL * 0.7 && index - lastSanitation >= 14) {
            treatments.push({ index, day: dayKey, type: 'sanitation', hhmm: '16:00' });
            lastSanitation = index;
        }
    });
    return treatments;
}

const PRODUCTS = {
    spray: { product: 'Abamectin 3.6EC + bả protein', activeIngredient: 'Abamectin', dose: '10 ml / 16 l nước', preHarvestDays: 7 },
    bait: { product: 'Bả protein (phun điểm)', activeIngredient: 'Protein thủy phân + Spinosad', dose: '1 m² mỗi cây', preHarvestDays: 3 },
    biological: { product: 'Thả ong ký sinh Fopius arisanus', activeIngredient: '', dose: '2.000 con / ha', preHarvestDays: 0 },
    sanitation: { product: 'Thu gom trái rụng', activeIngredient: '', dose: '', preHarvestDays: 0 }
};

/** Flies a lure photo of the trap shows at a slot (target for the photo choice). */
function lureTarget(trap, dayKey, slot, treatments) {
    const index = dayIndex(dayKey);
    const level = seasonal(trap.farm.region, dayKey, trap.farm.key) * treatmentFactor(treatments, index) * trap.factor;
    // Mornings catch a little more; a day-to-day wobble of +-30 %
    const slotFactor = slot === 0 ? 1.15 : 0.85;
    const noise = 0.7 + rand(`lure:${trap.serial}:${dayKey}:${slot}`) * 0.6;
    return Math.max(0, Math.round(level * slotFactor * noise));
}

// Sticky cards are changed every week (the first card on START_DAY)
const CARD_DAYS = 7;
const cardStartOf = (dayKey) => addDays(START_DAY, Math.floor(dayIndex(dayKey) / CARD_DAYS) * CARD_DAYS);

/** Flies stuck on the card at a slot: the sum of the days on this card (a share of today). */
function stickyTarget(trap, dayKey, slot, treatments, slotsPerDay) {
    const start = cardStartOf(dayKey);
    let total = 0;
    for (let d = start; d < dayKey; d = addDays(d, 1)) {
        total += seasonal(trap.farm.region, d, trap.farm.key) * treatmentFactor(treatments, dayIndex(d)) * trap.factor * 0.8;
    }
    const today = seasonal(trap.farm.region, dayKey, trap.farm.key) * treatmentFactor(treatments, dayIndex(dayKey)) * trap.factor * 0.8;
    total += today * ((slot + 1) / slotsPerDay);
    return Math.max(0, Math.round(total));
}

module.exports = {
    START_DAY,
    SHOWCASE,
    REGIONS,
    FARMS,
    NATIONAL_SLOTS,
    SHOWCASE_SLOTS,
    CARD_DAYS,
    ACTION_LEVEL,
    PRODUCTS,
    rand,
    dayKeyOf,
    at,
    addDays,
    dayIndex,
    daysUntil,
    cardStartOf,
    buildWorld,
    trapsOf,
    seasonal,
    treatmentFactor,
    fieldLogOf,
    lureTarget,
    stickyTarget
};
