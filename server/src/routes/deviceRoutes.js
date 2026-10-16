const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const env = require('../config/env');
const deviceService = require('../services/deviceService');
const { parseMultipart } = require('../utils/multipart');
const { rateLimit } = require('../middlewares/rateLimit');
const { sendServerError } = require('../utils/http');

/**
 * CamOS device API (flybot-aws docs/CONTRACTS.md section 2): what the ESP32 / AMB82 cameras call
 * over HTTPS. No user session: every call but /pair carries X-Device-Serial and X-Device-Token
 * (the token issued at pairing, stored hashed). Limits: 2 MB per photo, a few calls a minute
 * per camera, and per client IP first so bad tokens cannot hammer the check.
 */
const serialKey = (req) => String(req.get('X-Device-Serial') || '').slice(0, 64);
router.use(rateLimit({ windowMs: 60 * 1000, max: 120, keyFn: () => 'device', message: 'Too many requests.' }));

const json = (res, { status, body }) => res.status(status).json(body);

// The camera's one call after the portal provisioned it: 10 tries a minute per IP
router.post('/pair', express.json({ limit: '4kb' }), rateLimit({ windowMs: 60 * 1000, max: 10, keyFn: () => 'pair', message: 'Too many attempts.' }), async (req, res) => {
    try {
        const { serial, verifyCode, provisionToken } = req.body || {};
        json(res, await deviceService.pair({ serial, verifyCode, provisionToken }));
    } catch (err) {
        sendServerError(res, err, { context: 'Device pair' });
    }
});

/**
 * POST /events: the IoT rule fallback for camera -> cloud messages ({ topic, payload }), signed
 * with the shared secret IOT_RULE_SECRET (header X-IoT-Rule-Secret). Same handling as the MQTT
 * subscriber (platforms/camos.js handleMessage).
 */
router.post('/events', express.json({ limit: '64kb' }), async (req, res) => {
    const given = String(req.get('X-IoT-Rule-Secret') || '');
    const expected = env.IOT_RULE_SECRET;
    if (!expected) return res.status(503).json({ ok: false, error: 'disabled', message: 'IOT_RULE_SECRET is not set.' });
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const { topic, payload } = req.body || {};
    if (typeof topic !== 'string' || topic.length > 256) return res.status(400).json({ ok: false, error: 'bad_request', message: 'topic is required.' });
    try {
        const result = await require('../platforms/camos').handleMessage(topic, payload);
        res.json({ ok: true, handled: !!result, result });
    } catch (err) {
        sendServerError(res, err, { context: 'IoT rule event' });
    }
});

// Every other route: the paired camera
router.use(async (req, res, next) => {
    try {
        const camera = await deviceService.authenticate(req.get('X-Device-Serial'), req.get('X-Device-Token'));
        if (!camera) return res.status(401).json({ ok: false, error: 'unauthorized', message: 'Unknown device or bad token.' });
        req.camera = camera;
        next();
    } catch (err) {
        sendServerError(res, err, { context: 'Device auth' });
    }
});
// Per camera: a photo a minute on schedule, a few more on demand
router.use(rateLimit({ windowMs: 60 * 1000, max: 30, includeIp: false, keyFn: serialKey, message: 'Too many requests for this camera.' }));

router.get('/time', (req, res) => res.json(deviceService.timeNow()));

router.get('/ota', (req, res) => {
    const manifest = deviceService.otaManifest(req.camera);
    if (!manifest) return res.status(204).end();
    res.json(manifest);
});

/**
 * POST /snapshot multipart/form-data: part `image` (image/jpeg, <= 2 MB) and part `meta`
 * (application/json). 413 when too large, 415 when not a JPEG, 401 on a bad token.
 */
router.post('/snapshot', rateLimit({ windowMs: 60 * 1000, max: 12, includeIp: false, keyFn: serialKey, message: 'Too many photos for this camera.' }),
    express.raw({ type: 'multipart/form-data', limit: deviceService.MAX_IMAGE_BYTES + 64 * 1024 }),
    async (req, res) => {
        try {
            if (!Buffer.isBuffer(req.body) || !req.body.length) {
                return res.status(415).json({ ok: false, error: 'unsupported_type', message: 'multipart/form-data with an image part is required.' });
            }
            let parts;
            try {
                parts = parseMultipart(req.body, req.get('Content-Type'));
            } catch (err) {
                return res.status(400).json({ ok: false, error: 'bad_request', message: err.message });
            }
            const image = parts.find(p => p.name === 'image');
            const meta = parts.find(p => p.name === 'meta');
            json(res, await deviceService.storeDeviceSnapshot(req.camera, {
                image: image?.data,
                imageType: image?.contentType,
                meta: meta ? meta.data.toString('utf8') : undefined
            }));
        } catch (err) {
            sendServerError(res, err, { context: 'Device snapshot' });
        }
    });

module.exports = router;
