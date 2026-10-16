const env = require('../config/env');
const { Plan } = require('../models');
const { PLAN_CODES, PRICE_CURRENCIES } = require('../models/Plan');

/**
 * Plans (FREE / PRO / ENTERPRISE) as the admin configured them (Admin > Plans). The first read
 * seeds the collection with the placeholder numbers below; the admin edits them, FlyBot never
 * overwrites them. Reads are cached for a minute (and dropped on every admin change).
 *
 * The seed numbers are placeholders for the owner to set; no prices are invented (priceNote is
 * empty: the pricing page then says "Free" for FREE and "Contact us" for the others).
 * FREE starts from the demo settings (DEMO_MAX_CAMERAS_PER_USER, DEMO_MAX_SNAPSHOTS_PER_DAY,
 * DEMO_LIVE_MINUTES); after the first start the admin's values apply.
 */
const SEED = {
    free: {
        code: 'free', name: 'FREE', order: 1, visible: true,
        maxCameras: env.DEMO_MAX_CAMERAS_PER_USER, snapshotsPerDay: env.DEMO_MAX_SNAPSHOTS_PER_DAY, retentionDays: 30, deepAnalysisPerMonth: 20, liveMinutesPerRequest: Math.min(env.DEMO_LIVE_MINUTES, 60), maxMembers: 1,
        features: { telegram: true, pdfReports: false, apiAndWebhooks: false },
        priceNote: '', description: ''
    },
    pro: {
        code: 'pro', name: 'PRO', order: 2, visible: true,
        maxCameras: 10, snapshotsPerDay: 96, retentionDays: 180, deepAnalysisPerMonth: 300, liveMinutesPerRequest: 15, maxMembers: 5,
        features: { telegram: true, pdfReports: true, apiAndWebhooks: true },
        priceNote: '', description: ''
    },
    enterprise: {
        code: 'enterprise', name: 'ENTERPRISE', order: 3, visible: true,
        maxCameras: 100, snapshotsPerDay: 288, retentionDays: 730, deepAnalysisPerMonth: 5000, liveMinutesPerRequest: 30, maxMembers: 0,
        features: { telegram: true, pdfReports: true, apiAndWebhooks: true },
        priceNote: '', description: ''
    }
};

const EDITABLE = ['name', 'maxCameras', 'snapshotsPerDay', 'retentionDays', 'deepAnalysisPerMonth', 'liveMinutesPerRequest', 'maxMembers', 'priceNote', 'description', 'visible', 'order'];
const LIMITS = {
    maxCameras: [0, 100000], snapshotsPerDay: [1, 1440], retentionDays: [1, 3650], deepAnalysisPerMonth: [0, 1000000],
    liveMinutesPerRequest: [1, 60], maxMembers: [0, 100000], order: [0, 100]
};

// Online prices per currency (smallest unit); a plan without a price is not sold online
const PRICE_FIELDS = ['month', 'year', 'addonMonth', 'addonYear'];
const MAX_PRICE = 10_000_000_000;

let cache = null;
let cachedAt = 0;
const TTL_MS = 60 * 1000;

const view = (doc) => ({
    code: doc.code,
    name: doc.name,
    maxCameras: doc.maxCameras,
    snapshotsPerDay: doc.snapshotsPerDay,
    retentionDays: doc.retentionDays,
    deepAnalysisPerMonth: doc.deepAnalysisPerMonth,
    liveMinutesPerRequest: doc.liveMinutesPerRequest,
    maxMembers: doc.maxMembers,
    features: {
        telegram: doc.features?.telegram !== false,
        pdfReports: !!doc.features?.pdfReports,
        apiAndWebhooks: !!doc.features?.apiAndWebhooks
    },
    priceNote: doc.priceNote || '',
    prices: Object.fromEntries(PRICE_CURRENCIES.map(c => [c, Object.fromEntries(PRICE_FIELDS.map(f => [f, Number(doc.prices?.[c]?.[f]) || 0]))])),
    description: doc.description || '',
    visible: doc.visible !== false,
    order: doc.order ?? 0
});

/** Insert the plans that do not exist yet (never touches an existing one). */
async function ensureSeeded() {
    for (const code of PLAN_CODES) {
        await Plan.updateOne({ code }, { $setOnInsert: SEED[code] }, { upsert: true }).catch((err) => {
            if (err?.code !== 11000) throw err;
        });
    }
}

/** Every plan, in order: { free, pro, enterprise } of plain views. */
async function getPlans({ fresh = false } = {}) {
    if (!fresh && cache && Date.now() - cachedAt < TTL_MS) return cache;
    let docs = await Plan.find({}).lean();
    if (docs.length < PLAN_CODES.length) {
        await ensureSeeded();
        docs = await Plan.find({}).lean();
    }
    const byCode = Object.fromEntries(docs.map(d => [d.code, view(d)]));
    for (const code of PLAN_CODES) if (!byCode[code]) byCode[code] = view(SEED[code]);
    cache = byCode;
    cachedAt = Date.now();
    return byCode;
}

async function getPlan(code) {
    const plans = await getPlans();
    return plans[PLAN_CODES.includes(code) ? code : 'free'];
}

/** The plans in their order, for the pricing page (visible ones) or the admin (all). */
async function listPlans({ all = false } = {}) {
    const plans = Object.values(await getPlans());
    return plans.filter(p => all || p.visible).sort((a, b) => a.order - b.order);
}

/**
 * Admin edit of one plan. Returns { plan } or { error }.
 */
async function updatePlan(code, body, user) {
    if (!PLAN_CODES.includes(code)) return { error: 'Unknown plan.' };
    const b = body && typeof body === 'object' ? body : {};
    const set = {};
    for (const key of EDITABLE) {
        if (b[key] === undefined) continue;
        const value = b[key];
        if (LIMITS[key]) {
            const [min, max] = LIMITS[key];
            if (!Number.isInteger(value) || value < min || value > max) return { error: `${key} must be a whole number from ${min} to ${max}.` };
            set[key] = value;
        } else if (key === 'visible') {
            if (typeof value !== 'boolean') return { error: 'visible must be true or false.' };
            set[key] = value;
        } else {
            if (typeof value !== 'string') return { error: `${key} must be text.` };
            const text = value.trim().slice(0, key === 'description' ? 500 : key === 'priceNote' ? 200 : 40);
            if (key === 'name' && !text) return { error: 'name must not be empty.' };
            set[key] = text;
        }
    }
    if (b.features !== undefined) {
        if (!b.features || typeof b.features !== 'object') return { error: 'features must be an object.' };
        for (const f of ['telegram', 'pdfReports', 'apiAndWebhooks']) {
            if (b.features[f] === undefined) continue;
            if (typeof b.features[f] !== 'boolean') return { error: `features.${f} must be true or false.` };
            set[`features.${f}`] = b.features[f];
        }
    }
    if (b.prices !== undefined) {
        if (!b.prices || typeof b.prices !== 'object') return { error: 'prices must be an object.' };
        for (const currency of Object.keys(b.prices)) {
            if (!PRICE_CURRENCIES.includes(currency)) return { error: 'prices: currency must be VND or USD.' };
            const p = b.prices[currency];
            if (!p || typeof p !== 'object') return { error: `prices.${currency} must be an object.` };
            for (const f of PRICE_FIELDS) {
                if (p[f] === undefined) continue;
                if (!Number.isInteger(p[f]) || p[f] < 0 || p[f] > MAX_PRICE) return { error: `prices.${currency}.${f} must be a whole number from 0 to ${MAX_PRICE}.` };
                if (code === 'free' && p[f] !== 0) return { error: 'FREE has no price.' };
                set[`prices.${currency}.${f}`] = p[f];
            }
        }
    }
    await ensureSeeded();
    set.updatedBy = user?.id || user?._id || null;
    await Plan.updateOne({ code }, { $set: set });
    clearCache();
    return { plan: (await getPlans({ fresh: true }))[code] };
}

/**
 * What a plan costs online for one period: { amount, baseAmount, addonAmount } in the currency's
 * smallest unit, or null when the plan is not sold online in that currency / interval (or an
 * add-on camera has no price).
 */
async function quote(code, { currency, interval, addonCameras = 0 }) {
    if (code === 'free' || !PLAN_CODES.includes(code) || !PRICE_CURRENCIES.includes(currency)) return null;
    const plan = await getPlan(code);
    const prices = plan.prices[currency];
    const baseAmount = interval === 'year' ? prices.year : interval === 'month' ? prices.month : 0;
    if (!baseAmount) return null;
    const addonAmount = addonCameras > 0 ? (interval === 'year' ? prices.addonYear : prices.addonMonth) : 0;
    if (addonCameras > 0 && !addonAmount) return null;
    return { amount: baseAmount + addonAmount * addonCameras, baseAmount, addonAmount };
}

function clearCache() {
    cache = null;
    cachedAt = 0;
}

module.exports = {
    SEED,
    ensureSeeded,
    getPlans,
    getPlan,
    listPlans,
    updatePlan,
    quote,
    clearCache
};
