const crypto = require('crypto');
const axios = require('axios');
const env = require('../config/env');
const { User } = require('../models');
const { isAdmin } = require('../constants/roles');
const { getViewableSerials } = require('../utils/ownership');
const ezvizService = require('./ezvizService');

/**
 * Per-user EZVIZ sub-account (RAM) tokens for the browser player.
 *
 * The player needs an EZVIZ access token. Handing out the app account's token would let anyone
 * who can watch one camera control every device in the account. With EZVIZ_RAM_TOKENS=true,
 * each FlyBot user gets an EZVIZ sub-account whose policy lists only the cameras they may view
 * (view, live, playback), and the browser gets that sub-account's token instead.
 *
 * The policy is brought up to date before every token hand-out and by an hourly job, so
 * removed access ends within the hour even for someone who never opens the app again.
 * Admins see every camera anyway and keep the app token.
 */
const PERMISSIONS = 'Get,Real,Replay';
const EXPIRY_MARGIN_MS = 60 * 60 * 1000;

const enabled = () => String(env.EZVIZ_RAM_TOKENS || '').toLowerCase() === 'true';

// userId -> { accessToken, expireTime }
const tokenCache = new Map();

async function call(path, params) {
    const master = await ezvizService.getValidToken();
    if (!master) throw new Error('EZVIZ app token unavailable');
    const { areaDomain } = ezvizService.getCachedToken();
    const { data } = await axios.post(`${areaDomain || env.APP_DOMAIN}${path}`, ezvizService.toFormData({ accessToken: master, ...params }), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
    });
    if (String(data?.code) !== '200') throw new Error(`EZVIZ ${path}: ${data?.code} ${data?.msg || ''}`.trim());
    return data.data;
}

const policyOf = (serials) => ({
    Statement: serials.length
        ? [{ Permission: PERMISSIONS, Resource: serials.flatMap(s => [`dev:${s}`, `cam:${s}:1`]) }]
        : []
});
const hashOf = (serials) => crypto.createHash('sha256').update([...serials].sort().join(',')).digest('hex');

/** The user's sub-account id, created on first use. */
async function ensureAccount(user) {
    const doc = await User.findById(user.id ?? user._id).select('ezvizRam');
    if (doc?.ezvizRam?.accountId) return doc;
    // Password is never used to sign in; EZVIZ wants it as lower(md5(appKey#password))
    const password = crypto.createHash('md5').update(`${env.APP_KEY}#${crypto.randomBytes(18).toString('base64url')}`).digest('hex').toLowerCase();
    const created = await call('/api/lapp/ram/account/create', { accountName: `fb${doc._id}`, password });
    if (!created?.accountId) throw new Error('EZVIZ did not return a sub-account id');
    doc.ezvizRam = { accountId: created.accountId, policyHash: null, syncedAt: null };
    await doc.save();
    return doc;
}

/** Make the sub-account's policy list exactly these cameras (no call when unchanged). */
async function syncPolicy(doc, serials) {
    const hash = hashOf(serials);
    if (doc.ezvizRam.policyHash === hash) return false;
    await call('/api/lapp/ram/policy/set', { accountId: doc.ezvizRam.accountId, policy: JSON.stringify(policyOf(serials)) });
    await User.updateOne({ _id: doc._id }, { $set: { 'ezvizRam.policyHash': hash, 'ezvizRam.syncedAt': new Date() } });
    doc.ezvizRam.policyHash = hash;
    return true;
}

/**
 * The EZVIZ token to give this user's browser. Throws when sub-accounts are on but fail
 * (never falls back to the app token).
 */
async function playerTokenFor(user, appToken) {
    if (!enabled() || isAdmin(user)) return appToken;
    const doc = await ensureAccount(user);
    // Demo cameras (services/demoView.js) only while their live view is open to visitors
    await syncPolicy(doc, await getViewableSerials(user?.demoLive ? user : { ...user, demoSerials: [] }));
    const key = String(doc._id);
    const cached = tokenCache.get(key);
    if (cached && Date.now() < cached.expireTime - EXPIRY_MARGIN_MS) return cached.accessToken;
    const data = await call('/api/lapp/ram/token/get', { accountId: doc.ezvizRam.accountId });
    if (!data?.accessToken) throw new Error('EZVIZ did not return a sub-account token');
    tokenCache.set(key, { accessToken: data.accessToken, expireTime: Number(data.expireTime) || Date.now() + 24 * 60 * 60 * 1000 });
    return data.accessToken;
}

/**
 * Hourly: bring every sub-account's policy in line with what its user may view now
 * (disabled accounts get an empty policy).
 */
async function resyncAll() {
    if (!enabled()) return null;
    const users = await User.find({ 'ezvizRam.accountId': { $exists: true, $ne: null } }).select('role disabled ezvizRam');
    let changed = 0;
    for (const doc of users) {
        try {
            const serials = doc.disabled || isAdmin(doc) ? [] : await getViewableSerials(doc);
            if (await syncPolicy(doc, serials)) changed++;
        } catch (err) {
            console.warn(`⚠️ EZVIZ sub-account policy sync failed (${doc._id}):`, err.message);
        }
    }
    if (changed) console.log(`🔐 EZVIZ sub-account policies updated: ${changed}.`);
    return changed;
}

/** When a FlyBot account is deleted, its sub-account goes too. */
async function deleteAccount(user) {
    tokenCache.delete(String(user._id ?? user.id));
    const accountId = user.ezvizRam?.accountId;
    if (!enabled() || !accountId) return false;
    await call('/api/lapp/ram/account/delete', { accountId });
    return true;
}

module.exports = {
    enabled,
    policyOf,
    playerTokenFor,
    resyncAll,
    deleteAccount,
    tokenCache
};
