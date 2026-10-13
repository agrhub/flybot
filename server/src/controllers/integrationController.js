const crypto = require('crypto');
const mongoose = require('mongoose');
const { ApiKey, Webhook } = require('../models');
const { WEBHOOK_EVENTS } = require('../models/Webhook');
const { sendServerError } = require('../utils/http');
const { recordAudit } = require('../services/auditService');
const webhookService = require('../services/webhookService');
const { KEY_PREFIX, hashKey } = require('./publicApiController');

/**
 * Settings > API & webhooks: my API keys and webhooks.
 */
const MAX_KEYS = 10;
const MAX_WEBHOOKS = 10;

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

const keyOut = (k) => ({ id: String(k._id), name: k.name, prefix: k.prefix, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt });
const hookOut = (h) => ({
    id: String(h._id),
    url: h.url,
    events: h.events,
    active: h.active,
    lastDeliveryAt: h.lastDeliveryAt,
    lastStatus: h.lastStatus,
    lastError: h.lastError,
    failures: h.failures,
    createdAt: h.createdAt
});

// ---------- API keys ----------

async function listKeys(req, res) {
    try {
        const keys = await ApiKey.find({ userId: req.user.id, revokedAt: null }).sort({ createdAt: -1 }).lean();
        res.json({ success: true, keys: keys.map(keyOut) });
    } catch (err) {
        sendServerError(res, err, { context: 'List API keys' });
    }
}

/** POST /api/integrations/keys { name }: the key is in this response only */
async function createKey(req, res) {
    try {
        const name = text(req.body.name, 60);
        if (!name) return res.status(400).json({ success: false, message: "Please enter a name for the key." });
        if ((await ApiKey.countDocuments({ userId: req.user.id, revokedAt: null })) >= MAX_KEYS) {
            return res.status(400).json({ success: false, message: `You can have at most ${MAX_KEYS} API keys.` });
        }
        const key = `${KEY_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
        const doc = await ApiKey.create({ userId: req.user.id, name, prefix: key.slice(0, 12), hash: hashKey(key) });
        recordAudit(req, { action: 'integration.key_created', target: { type: 'api_key', id: String(doc._id), label: name } });
        res.status(201).json({ success: true, key, apiKey: keyOut(doc) });
    } catch (err) {
        sendServerError(res, err, { context: 'Create API key' });
    }
}

async function revokeKey(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: "API key not found." });
        const doc = await ApiKey.findOneAndUpdate({ _id: req.params.id, userId: req.user.id, revokedAt: null }, { $set: { revokedAt: new Date() } });
        if (!doc) return res.status(404).json({ success: false, message: "API key not found." });
        recordAudit(req, { action: 'integration.key_revoked', target: { type: 'api_key', id: String(doc._id), label: doc.name } });
        res.json({ success: true });
    } catch (err) {
        sendServerError(res, err, { context: 'Revoke API key' });
    }
}

// ---------- Webhooks ----------

function parseEvents(value) {
    if (!Array.isArray(value) || !value.length) return { error: 'Choose at least one event.' };
    const events = [...new Set(value)];
    if (events.some(e => !WEBHOOK_EVENTS.includes(e))) return { error: 'Unknown event.' };
    return { events };
}

async function listWebhooks(req, res) {
    try {
        const hooks = await Webhook.find({ userId: req.user.id }).sort({ createdAt: -1 }).lean();
        res.json({ success: true, webhooks: hooks.map(hookOut), events: WEBHOOK_EVENTS });
    } catch (err) {
        sendServerError(res, err, { context: 'List webhooks' });
    }
}

/** POST /api/integrations/webhooks { url, events }: the signing secret is in this response only */
async function createWebhook(req, res) {
    try {
        const url = text(req.body.url, 600);
        const problem = webhookService.urlProblem(url);
        if (problem) return res.status(400).json({ success: false, message: problem });
        const parsed = parseEvents(req.body.events);
        if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
        if ((await Webhook.countDocuments({ userId: req.user.id })) >= MAX_WEBHOOKS) {
            return res.status(400).json({ success: false, message: `You can have at most ${MAX_WEBHOOKS} webhooks.` });
        }
        const secret = webhookService.newSecret();
        const hook = await Webhook.create({ userId: req.user.id, url, secret, events: parsed.events });
        recordAudit(req, { action: 'integration.webhook_created', target: { type: 'webhook', id: String(hook._id), label: url } });
        res.status(201).json({ success: true, secret, webhook: hookOut(hook) });
    } catch (err) {
        sendServerError(res, err, { context: 'Create webhook' });
    }
}

async function loadHook(req, res) {
    const hook = mongoose.isValidObjectId(req.params.id) ? await Webhook.findOne({ _id: req.params.id, userId: req.user.id }) : null;
    if (!hook) res.status(404).json({ success: false, message: "Webhook not found." });
    return hook;
}

/** PUT /api/integrations/webhooks/:id { url?, events?, active? } */
async function updateWebhook(req, res) {
    try {
        const hook = await loadHook(req, res);
        if (!hook) return;
        if (req.body.url !== undefined) {
            const url = text(req.body.url, 600);
            const problem = webhookService.urlProblem(url);
            if (problem) return res.status(400).json({ success: false, message: problem });
            hook.url = url;
        }
        if (req.body.events !== undefined) {
            const parsed = parseEvents(req.body.events);
            if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
            hook.events = parsed.events;
        }
        if (req.body.active !== undefined) {
            if (typeof req.body.active !== 'boolean') return res.status(400).json({ success: false, message: "active must be true or false." });
            hook.active = req.body.active;
            // Turning it back on starts a fresh failure count
            if (hook.active) hook.failures = 0;
        }
        await hook.save();
        recordAudit(req, { action: 'integration.webhook_updated', target: { type: 'webhook', id: String(hook._id), label: hook.url }, details: { events: hook.events, active: hook.active } });
        res.json({ success: true, webhook: hookOut(hook) });
    } catch (err) {
        sendServerError(res, err, { context: 'Update webhook' });
    }
}

async function deleteWebhook(req, res) {
    try {
        const hook = await loadHook(req, res);
        if (!hook) return;
        await hook.deleteOne();
        recordAudit(req, { action: 'integration.webhook_deleted', target: { type: 'webhook', id: String(hook._id), label: hook.url } });
        res.json({ success: true });
    } catch (err) {
        sendServerError(res, err, { context: 'Delete webhook' });
    }
}

/** POST /api/integrations/webhooks/:id/test: send a "ping" now */
async function testWebhook(req, res) {
    try {
        const hook = await loadHook(req, res);
        if (!hook) return;
        const result = await webhookService.ping(hook);
        res.json({ success: true, result: { ok: result.ok, status: result.status, error: result.error } });
    } catch (err) {
        sendServerError(res, err, { context: 'Test webhook' });
    }
}

module.exports = {
    listKeys,
    createKey,
    revokeKey,
    listWebhooks,
    createWebhook,
    updateWebhook,
    deleteWebhook,
    testWebhook
};
