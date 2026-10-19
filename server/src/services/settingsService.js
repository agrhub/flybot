const { SystemSetting } = require('../models');
const { ALLOW_REGISTRATION, RETENTION_CYCLE, DEMO_VIEW_ENABLED, DEMO_VIEW_CAMERAS, DEMO_VIEW_SINCE, DEMO_VIEW_LIVE, DEMO_VIEW_SIMULATED, DEMO_SIM_ENABLED, DEMO_SIM_UNTIL, DEMO_VIEW_AUDIENCE, GUEST_ACCESS } = require('../config/env');
const { DEFAULT_ALERT_THRESHOLD } = require('../constants/risk');

// Short cache: settings are read on every registration/cleanup but change rarely
const CACHE_MS = 30 * 1000;
let cached = null;
let cachedAt = 0;

const defaults = () => ({
    allowRegistration: ALLOW_REGISTRATION,
    retentionMonths: RETENTION_CYCLE,
    defaultAlertThreshold: DEFAULT_ALERT_THRESHOLD,
    trainingSync: false,
    // Read-only demo cameras for visitors (services/demoView.js)
    demoViewEnabled: DEMO_VIEW_ENABLED,
    demoViewCameras: [...DEMO_VIEW_CAMERAS],
    demoViewSince: DEMO_VIEW_SINCE,
    demoViewLive: DEMO_VIEW_LIVE,
    demoViewAudience: DEMO_VIEW_AUDIENCE,
    // The shared, read-only guest account (services/guestAccess.js)
    guestAccessEnabled: GUEST_ACCESS,
    // The simulated demo farm (scripts/demo_sim.js): shown to visitors, and its daily simulation
    demoViewSimulated: DEMO_VIEW_SIMULATED,
    demoSimEnabled: DEMO_SIM_ENABLED,
    demoSimUntil: DEMO_SIM_UNTIL
});
// Saved as null on purpose ("every account"): null does not fall back to the environment
const NULLABLE = new Set(['demoViewSince', 'demoSimUntil']);

/**
 * Effective settings: the admin-saved values, falling back to the environment.
 */
async function getSettings() {
    if (cached && Date.now() - cachedAt < CACHE_MS) return cached;
    const doc = await SystemSetting.findOne({ key: 'global' }).lean();
    const merged = { ...defaults() };
    for (const key of Object.keys(merged)) {
        if (doc && doc[key] !== undefined && (doc[key] !== null || NULLABLE.has(key))) merged[key] = doc[key];
    }
    for (const key of NULLABLE) merged[key] = merged[key] ? new Date(merged[key]).toISOString() : null;
    merged.updatedAt = doc?.updatedAt || null;
    cached = merged;
    cachedAt = Date.now();
    return merged;
}

const SETTING_RULES = {
    allowRegistration: (v) => typeof v === 'boolean',
    retentionMonths: (v) => Number.isInteger(v) && v >= 1 && v <= 60,
    defaultAlertThreshold: (v) => Number.isInteger(v) && v >= 1 && v <= 10000,
    trainingSync: (v) => typeof v === 'boolean',
    demoViewEnabled: (v) => typeof v === 'boolean',
    demoViewCameras: (v) => Array.isArray(v) && v.length <= 20 && v.every(s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s)),
    // A date (accounts created on or after it) or null (every account)
    demoViewSince: (v) => v === null || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v))),
    demoViewLive: (v) => typeof v === 'boolean',
    demoViewSimulated: (v) => typeof v === 'boolean',
    demoViewAudience: (v) => ['guest', 'all', 'since'].includes(v),
    guestAccessEnabled: (v) => typeof v === 'boolean',
    demoSimEnabled: (v) => typeof v === 'boolean',
    // The last day the daily simulation adds data (null: no end)
    demoSimUntil: (v) => v === null || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v)))
};
const normalize = (key, value) => {
    if (key === 'demoViewCameras') return [...new Set(value)];
    if (NULLABLE.has(key)) return value ? new Date(value) : null;
    return value;
};

/**
 * Validate and save a partial update. Returns { settings } or { error }.
 */
async function updateSettings(patch, userId) {
    if (!patch || typeof patch !== 'object') return { error: 'Settings must be an object.' };
    const update = {};
    for (const [key, value] of Object.entries(patch)) {
        const rule = SETTING_RULES[key];
        if (!rule) return { error: `Unknown setting "${key}".` };
        if (!rule(value)) return { error: `Invalid value for "${key}".` };
        update[key] = normalize(key, value);
    }
    await SystemSetting.updateOne(
        { key: 'global' },
        { $set: { ...update, updatedBy: userId, updatedAt: new Date() } },
        { upsert: true }
    );
    cached = null;
    return { settings: await getSettings() };
}

function clearCache() {
    cached = null;
}

module.exports = {
    getSettings,
    updateSettings,
    clearCache
};
