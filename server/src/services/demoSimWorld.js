/**
 * The simulated demo farm's world (services/demoSim.js): farms across every province of Vietnam
 * and fruit regions abroad, their plots and traps, and the fly level every trap would see each
 * day. Pure functions only, so the seed and the daily job compute exactly the same plan.
 *
 * Everything here is made up for the demo: farm-level points near district centres (not real
 * farms), plausible crops, trap kinds and main fruit flies, and a seasonal wave per region. The
 * photos are labeled synthetic pictures; the counts FlyBot stores come from the real vision
 * pipeline on them. Names are English (place names keep their spelling) so visitors from abroad
 * can read them; Vietnamese provinces are those of the 2025 map (34 provinces and cities).
 */
const TZ_OFFSET_MS = 7 * 3600 * 1000; // Asia/Ho_Chi_Minh, no daylight saving: FlyBot's farm day
const DAY_MS = 24 * 3600 * 1000;

// The simulation starts here (the first day of the synthetic photo set)
const START_DAY = '2026-09-19';

// Each region's fly wave: base flies a photo, wave height, peak day of year and width (days)
const REGIONS = {
    mekong: { base: 4, amp: 22, peak: 300, width: 28 },
    southeast: { base: 3, amp: 18, peak: 285, width: 25 },
    highlands: { base: 3, amp: 16, peak: 262, width: 30 },
    central: { base: 2, amp: 14, peak: 318, width: 22 },
    north: { base: 1, amp: 4, peak: 225, width: 35 },
    // Abroad (main fruit fly in each farm's description)
    seasia: { base: 4, amp: 18, peak: 290, width: 35 },
    southasia: { base: 3, amp: 16, peak: 225, width: 40 },
    eastasia: { base: 2, amp: 12, peak: 205, width: 40 },
    oceania: { base: 2, amp: 16, peak: 335, width: 30 },
    eastafrica: { base: 3, amp: 18, peak: 320, width: 35 },
    southafrica: { base: 2, amp: 14, peak: 345, width: 30 },
    mediterranean: { base: 3, amp: 20, peak: 272, width: 28 },
    americasN: { base: 1, amp: 10, peak: 80, width: 40 },
    americasS: { base: 3, amp: 18, peak: 300, width: 35 }
};

const SHOWCASE = 'SHOW';

/**
 * Detailed farms: two plots of two traps (one sticky card beside lure traps, as growers mix them).
 * `legacyName`: the Vietnamese name of the first seed, so an existing farm is renamed in place.
 */
const FARMS = [
    { key: 'CAIBE', name: 'Cái Bè mango orchard', short: 'Cái Bè mango', province: 'Đồng Tháp', region: 'mekong', crop: 'Hòa Lộc mango', lat: 10.3390, lng: 106.0320, legacyName: 'Vườn xoài Cái Bè' },
    { key: 'CHOLACH', name: 'Chợ Lách pomelo orchard', short: 'Chợ Lách pomelo', province: 'Vĩnh Long', region: 'mekong', crop: 'Green-skin pomelo', lat: 10.2620, lng: 106.1330, legacyName: 'Vườn bưởi Chợ Lách' },
    { key: 'CAOLANH', name: 'Cao Lãnh mango orchard', short: 'Cao Lãnh mango', province: 'Đồng Tháp', region: 'mekong', crop: 'Mango', lat: 10.4600, lng: 105.6330, legacyName: 'Vườn xoài Cao Lãnh' },
    { key: 'HAMTHUAN', name: 'Hàm Thuận Bắc dragon fruit farm', short: 'Hàm Thuận dragon fruit', province: 'Lâm Đồng', region: 'southeast', crop: 'Red dragon fruit', lat: 11.0800, lng: 108.0700, legacyName: 'Vườn thanh long Hàm Thuận Bắc' },
    { key: 'LONGKHANH', name: 'Long Khánh rambutan orchard', short: 'Long Khánh rambutan', province: 'Đồng Nai', region: 'southeast', crop: 'Rambutan', lat: 10.9300, lng: 107.2400, legacyName: 'Vườn chôm chôm Long Khánh' },
    { key: 'KRONGPAC', name: 'Krông Pắc durian orchard', short: 'Krông Pắc durian', province: 'Đắk Lắk', region: 'highlands', crop: 'Durian', lat: 12.7000, lng: 108.3000, legacyName: 'Vườn sầu riêng Krông Pắc' },
    { key: 'CAMLAM', name: 'Cam Lâm mango orchard', short: 'Cam Lâm mango', province: 'Khánh Hòa', region: 'central', crop: 'Australian mango', lat: 12.0800, lng: 109.1000, legacyName: 'Vườn xoài Cam Lâm' },
    { key: 'KHOAICHAU', name: 'Khoái Châu longan orchard', short: 'Khoái Châu longan', province: 'Hưng Yên', region: 'north', crop: 'Longan', lat: 20.8400, lng: 105.9700, legacyName: 'Vườn nhãn Khoái Châu' },
    { key: 'LUCNGAN', name: 'Lục Ngạn lychee orchard', short: 'Lục Ngạn lychee', province: 'Bắc Ninh', region: 'north', crop: 'Lychee', lat: 21.3800, lng: 106.5800, legacyName: 'Vườn vải Lục Ngạn' }
];

/**
 * Compact farms, one per remaining province of Vietnam and a dozen fruit regions abroad: one plot,
 * one sticky card and one lure trap, one photo a day. `tz`: the farm's time zone and UTC offset
 * (photos are taken at local daylight times); `pest`: the region's main fruit fly.
 */
const VN = { country: 'Vietnam', tz: 'Asia/Ho_Chi_Minh', offset: '+07:00', pest: 'Bactrocera dorsalis' };
const COMPACT_FARMS = [
    // Vietnam: the provinces and cities without a detailed farm (2025 map)
    { key: 'HANOI', name: 'Chương Mỹ pomelo orchard', short: 'Chương Mỹ pomelo', province: 'Hà Nội', region: 'north', crop: 'Pomelo', lat: 20.9200, lng: 105.7000, ...VN },
    { key: 'HUE', name: 'Thủy Biều pomelo garden', short: 'Thủy Biều pomelo', province: 'Huế', region: 'central', crop: 'Thanh Trà pomelo', lat: 16.4400, lng: 107.5500, ...VN },
    { key: 'HAIPHONG', name: 'Thanh Hà lychee orchard', short: 'Thanh Hà lychee', province: 'Hải Phòng', region: 'north', crop: 'Lychee', lat: 20.9000, lng: 106.4300, ...VN },
    { key: 'DANANG', name: 'Đại Lộc mango orchard', short: 'Đại Lộc mango', province: 'Đà Nẵng', region: 'central', crop: 'Mango', lat: 15.8800, lng: 108.0900, ...VN },
    { key: 'CANTHO', name: 'Phong Điền mango orchard', short: 'Phong Điền mango', province: 'Cần Thơ', region: 'mekong', crop: 'Mango', lat: 10.0000, lng: 105.6700, ...VN },
    { key: 'TUYENQUANG', name: 'Hàm Yên orange orchard', short: 'Hàm Yên orange', province: 'Tuyên Quang', region: 'north', crop: 'Orange', lat: 22.0700, lng: 105.0400, ...VN },
    { key: 'LAOCAI', name: 'Văn Chấn orange orchard', short: 'Văn Chấn orange', province: 'Lào Cai', region: 'north', crop: 'Orange', lat: 21.5800, lng: 104.5300, ...VN },
    { key: 'THAINGUYEN', name: 'Đồng Hỷ guava orchard', short: 'Đồng Hỷ guava', province: 'Thái Nguyên', region: 'north', crop: 'Guava', lat: 21.6800, lng: 105.9000, ...VN },
    { key: 'PHUTHO', name: 'Cao Phong orange orchard', short: 'Cao Phong orange', province: 'Phú Thọ', region: 'north', crop: 'Orange', lat: 20.7000, lng: 105.3300, ...VN },
    { key: 'NINHBINH', name: 'Gia Viễn guava orchard', short: 'Gia Viễn guava', province: 'Ninh Bình', region: 'north', crop: 'Guava', lat: 20.3300, lng: 105.8600, ...VN },
    { key: 'QUANGTRI', name: 'Gio Linh guava orchard', short: 'Gio Linh guava', province: 'Quảng Trị', region: 'central', crop: 'Guava', lat: 16.9200, lng: 107.1000, ...VN },
    { key: 'QUANGNGAI', name: 'Tư Nghĩa mango orchard', short: 'Tư Nghĩa mango', province: 'Quảng Ngãi', region: 'central', crop: 'Mango', lat: 15.1000, lng: 108.7800, ...VN },
    { key: 'GIALAI', name: 'Chư Prông durian orchard', short: 'Chư Prông durian', province: 'Gia Lai', region: 'highlands', crop: 'Durian', lat: 13.7500, lng: 107.8800, ...VN },
    { key: 'TAYNINH', name: 'Bà Đen custard apple orchard', short: 'Bà Đen custard apple', province: 'Tây Ninh', region: 'southeast', crop: 'Custard apple', lat: 11.3700, lng: 106.1500, ...VN },
    { key: 'CAMAU', name: 'U Minh guava orchard', short: 'U Minh guava', province: 'Cà Mau', region: 'mekong', crop: 'Guava', lat: 9.4000, lng: 104.9700, ...VN },
    { key: 'ANGIANG', name: 'Tri Tôn mango orchard', short: 'Tri Tôn mango', province: 'An Giang', region: 'mekong', crop: 'Mango', lat: 10.4200, lng: 105.0000, ...VN },
    { key: 'LAICHAU', name: 'Than Uyên plum orchard', short: 'Than Uyên plum', province: 'Lai Châu', region: 'north', crop: 'Plum', lat: 21.9500, lng: 103.8900, ...VN },
    { key: 'DIENBIEN', name: 'Mường Thanh guava orchard', short: 'Mường Thanh guava', province: 'Điện Biên', region: 'north', crop: 'Guava', lat: 21.3800, lng: 103.0200, ...VN },
    { key: 'SONLA', name: 'Yên Châu mango orchard', short: 'Yên Châu mango', province: 'Sơn La', region: 'north', crop: 'Mango', lat: 21.0400, lng: 104.3000, ...VN },
    { key: 'LANGSON', name: 'Chi Lăng custard apple orchard', short: 'Chi Lăng custard apple', province: 'Lạng Sơn', region: 'north', crop: 'Custard apple', lat: 21.6700, lng: 106.6200, ...VN },
    { key: 'CAOBANG', name: 'Hòa An plum orchard', short: 'Hòa An plum', province: 'Cao Bằng', region: 'north', crop: 'Plum', lat: 22.7000, lng: 106.2000, ...VN },
    { key: 'QUANGNINH', name: 'Đông Triều lychee orchard', short: 'Đông Triều lychee', province: 'Quảng Ninh', region: 'north', crop: 'Lychee', lat: 21.0800, lng: 106.5100, ...VN },
    { key: 'HATINH', name: 'Vũ Quang orange orchard', short: 'Vũ Quang orange', province: 'Hà Tĩnh', region: 'central', crop: 'Orange', lat: 18.3800, lng: 105.4700, ...VN },
    { key: 'NGHEAN', name: 'Quỳ Hợp orange orchard', short: 'Quỳ Hợp orange', province: 'Nghệ An', region: 'central', crop: 'Orange', lat: 19.3200, lng: 105.1700, ...VN },
    { key: 'THANHHOA', name: 'Ngọc Lặc pomelo orchard', short: 'Ngọc Lặc pomelo', province: 'Thanh Hóa', region: 'central', crop: 'Pomelo', lat: 20.1000, lng: 105.3800, ...VN },
    // Abroad: fruit regions with their main fruit fly
    { key: 'TH', name: 'Chanthaburi durian orchard', short: 'Chanthaburi durian', province: 'Chanthaburi', country: 'Thailand', region: 'seasia', crop: 'Durian', pest: 'Bactrocera dorsalis', tz: 'Asia/Bangkok', offset: '+07:00', lat: 12.6100, lng: 102.1000 },
    { key: 'PH', name: 'Guimaras mango orchard', short: 'Guimaras mango', province: 'Guimaras', country: 'Philippines', region: 'seasia', crop: 'Carabao mango', pest: 'Bactrocera occipitalis', tz: 'Asia/Manila', offset: '+08:00', lat: 10.5900, lng: 122.6300 },
    { key: 'IN', name: 'Ratnagiri mango orchard', short: 'Ratnagiri mango', province: 'Maharashtra', country: 'India', region: 'southasia', crop: 'Alphonso mango', pest: 'Bactrocera dorsalis', tz: 'Asia/Kolkata', offset: '+05:30', lat: 16.9900, lng: 73.3000 },
    { key: 'CN', name: 'Zengcheng lychee orchard', short: 'Zengcheng lychee', province: 'Guangdong', country: 'China', region: 'eastasia', crop: 'Lychee', pest: 'Bactrocera dorsalis', tz: 'Asia/Shanghai', offset: '+08:00', lat: 23.2900, lng: 113.8300 },
    { key: 'TW', name: 'Pingtung mango orchard', short: 'Pingtung mango', province: 'Pingtung', country: 'Taiwan', region: 'eastasia', crop: 'Irwin mango', pest: 'Bactrocera dorsalis', tz: 'Asia/Taipei', offset: '+08:00', lat: 22.5500, lng: 120.5500 },
    { key: 'AU', name: 'Bowen mango farm', short: 'Bowen mango', province: 'Queensland', country: 'Australia', region: 'oceania', crop: 'Kensington Pride mango', pest: 'Bactrocera tryoni (Queensland fruit fly)', tz: 'Australia/Brisbane', offset: '+10:00', lat: -20.0100, lng: 148.2400 },
    { key: 'KE', name: 'Makueni mango farm', short: 'Makueni mango', province: 'Makueni', country: 'Kenya', region: 'eastafrica', crop: 'Apple mango', pest: 'Bactrocera dorsalis', tz: 'Africa/Nairobi', offset: '+03:00', lat: -1.8000, lng: 37.6200 },
    { key: 'ZA', name: 'Limpopo citrus orchard', short: 'Limpopo citrus', province: 'Limpopo', country: 'South Africa', region: 'southafrica', crop: 'Navel orange', pest: 'Ceratitis capitata (Mediterranean fruit fly)', tz: 'Africa/Johannesburg', offset: '+02:00', lat: -23.9000, lng: 30.5000 },
    { key: 'ES', name: 'Valencia citrus orchard', short: 'Valencia citrus', province: 'Valencia', country: 'Spain', region: 'mediterranean', crop: 'Clementine', pest: 'Ceratitis capitata (Mediterranean fruit fly)', tz: 'Europe/Madrid', offset: '+01:00', lat: 39.3000, lng: -0.4000 },
    { key: 'MX', name: 'Michoacán mango orchard', short: 'Michoacán mango', province: 'Michoacán', country: 'Mexico', region: 'americasN', crop: 'Ataulfo mango', pest: 'Anastrepha ludens (Mexican fruit fly)', tz: 'America/Mexico_City', offset: '-06:00', lat: 19.1000, lng: -102.4000 },
    { key: 'BR', name: 'Petrolina mango farm', short: 'Petrolina mango', province: 'Pernambuco', country: 'Brazil', region: 'americasS', crop: 'Tommy Atkins mango', pest: 'Ceratitis capitata and Anastrepha obliqua', tz: 'America/Recife', offset: '-03:00', lat: -9.3900, lng: -40.5000 },
    { key: 'US', name: 'Rio Grande Valley citrus grove', short: 'Rio Grande citrus', province: 'Texas', country: 'United States', region: 'americasN', crop: 'Ruby Red grapefruit', pest: 'Anastrepha ludens (Mexican fruit fly)', tz: 'America/Chicago', offset: '-06:00', lat: 26.2000, lng: -98.2300 }
];

// The showcase farm: the synthetic set's four traps keep their own ids and points
const SHOWCASE_FARM = { key: SHOWCASE, name: 'Showcase orchard', short: 'Showcase', province: 'Hồ Chí Minh City', region: 'southeast', crop: 'Mango', lat: 11.1502, lng: 106.4003, legacyName: 'Vườn trình diễn' };

// Photos a day (local time): detailed farms twice, compact farms once; the showcase traps use
// their set's slots
const NATIONAL_SLOTS = ['07:00', '15:30'];
const COMPACT_SLOTS = ['07:30'];
const SHOWCASE_SLOTS = ['06:30', '09:00', '11:30', '14:00', '16:30'];
const PLOT_LEGACY = ['Lô A', 'Lô B'];

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
/** The instant of a local day and 'HH:MM' at a UTC offset (Vietnam by default). */
const at = (dayKey, hhmm, offset = '+07:00') => new Date(`${dayKey}T${hhmm}:00${offset}`);
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

const trapOf = (farm, n, kind, lat, lng, t) => ({
    serial: `SIM-${farm.key}-${n}`,
    name: `SIM · ${farm.short} ${n}`,
    kind,
    lat: lat - 0.0003 - t * 0.0003,
    lng: lng + 0.0003 + t * 0.0005,
    factor: 0.7 + rand(`factor:${farm.key}:${n}`) * 0.6
});

/**
 * The world: farms with their plots and traps. Trap serials are SIM-<FARM>-<n>; the showcase
 * traps map the synthetic set's trap ids (manifest traps[]) to SIM-SHOW-<A..D>.
 */
function buildWorld(showcaseTraps = []) {
    const detailed = FARMS.map((farm) => {
        const plots = [0, 1].map((p) => {
            const lat = farm.lat + (p ? -0.0012 : 0);
            const lng = farm.lng + (p ? 0.0004 : 0);
            // Each farm keeps one sticky card (on its first plot) beside its lure traps
            const traps = [0, 1].map(t => trapOf(farm, p * 2 + t + 1, p === 0 && t === 0 ? 'sticky' : 'lure', lat, lng, t));
            return { key: `${farm.key}-${p + 1}`, name: `Plot ${String.fromCharCode(65 + p)}`, legacyName: PLOT_LEGACY[p], crop: farm.crop, boundary: boundaryAround(lat, lng), traps };
        });
        return { ...VN, ...farm, plots, slots: NATIONAL_SLOTS, showcase: false };
    });
    const compact = COMPACT_FARMS.map((farm) => ({
        ...farm,
        slots: COMPACT_SLOTS,
        showcase: false,
        plots: [{ key: `${farm.key}-1`, name: 'Plot A', crop: farm.crop, boundary: boundaryAround(farm.lat, farm.lng), traps: [trapOf(farm, 1, 'sticky', farm.lat, farm.lng, 0), trapOf(farm, 2, 'lure', farm.lat, farm.lng, 1)] }]
    }));
    const farms = [...detailed, ...compact];
    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    const showTraps = showcaseTraps.slice(0, letters.length).map((t, i) => ({
        serial: `SIM-${SHOWCASE}-${letters[i]}`,
        name: `SIM · Showcase ${letters[i]}`,
        kind: t.trapKind === 'sticky' ? 'sticky' : 'lure',
        lat: Number.isFinite(t.lat) ? t.lat : SHOWCASE_FARM.lat - i * 0.0003,
        lng: Number.isFinite(t.lon) ? t.lon : SHOWCASE_FARM.lng + i * 0.0003,
        factor: 1,
        setTrap: t.id
    }));
    if (showTraps.length) {
        farms.unshift({
            ...VN,
            ...SHOWCASE_FARM,
            showcase: true,
            slots: SHOWCASE_SLOTS,
            plots: [{ key: `${SHOWCASE}-1`, name: 'Showcase plot', legacyName: 'Lô trình diễn', crop: SHOWCASE_FARM.crop, boundary: boundaryAround(SHOWCASE_FARM.lat + 0.0004, SHOWCASE_FARM.lng - 0.0004), traps: showTraps }]
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
    spray: { product: 'Abamectin 3.6EC + protein bait', activeIngredient: 'Abamectin', dose: '10 ml per 16 l of water', preHarvestDays: 7 },
    bait: { product: 'Protein bait (spot spray)', activeIngredient: 'Hydrolyzed protein + spinosad', dose: '1 m² per tree', preHarvestDays: 3 },
    biological: { product: 'Release of Fopius arisanus parasitoid wasps', activeIngredient: '', dose: '2,000 wasps per ha', preHarvestDays: 0 },
    sanitation: { product: 'Fallen fruit collection', activeIngredient: '', dose: '', preHarvestDays: 0 }
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
    COMPACT_FARMS,
    NATIONAL_SLOTS,
    COMPACT_SLOTS,
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
