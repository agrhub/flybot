const { SystemSetting } = require('../models');
const { ALLOW_REGISTRATION, RETENTION_CYCLE } = require('../config/env');
const { DEFAULT_ALERT_THRESHOLD } = require('../constants/risk');

// Short cache: settings are read on every registration/cleanup but change rarely
const CACHE_MS = 30 * 1000;
let cached = null;
let cachedAt = 0;

const defaults = () => ({
    allowRegistration: ALLOW_REGISTRATION,
    retentionMonths: RETENTION_CYCLE,
    defaultAlertThreshold: DEFAULT_ALERT_THRESHOLD,
    trainingSync: false
});

/**
 * Effective settings: the admin-saved values, falling back to the environment.
 */
async function getSettings() {
    if (cached && Date.now() - cachedAt < CACHE_MS) return cached;
    const doc = await SystemSetting.findOne({ key: 'global' }).lean();
    const merged = { ...defaults() };
    for (const key of Object.keys(merged)) {
        if (doc && doc[key] !== undefined && doc[key] !== null) merged[key] = doc[key];
    }
    merged.updatedAt = doc?.updatedAt || null;
    cached = merged;
    cachedAt = Date.now();
    return merged;
}

const SETTING_RULES = {
    allowRegistration: (v) => typeof v === 'boolean',
    retentionMonths: (v) => Number.isInteger(v) && v >= 1 && v <= 60,
    defaultAlertThreshold: (v) => Number.isInteger(v) && v >= 1 && v <= 10000,
    trainingSync: (v) => typeof v === 'boolean'
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
        update[key] = value;
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
