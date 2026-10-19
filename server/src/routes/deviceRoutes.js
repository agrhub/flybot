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
 * POST /register: zero-touch self-registration of the public firmware (CONTRACTS 2a). No auth;
 * per client IP and in total per hour; the body carries the camera's CSR (a few hundred bytes).
 */
router.post('/register',
    rateLimit({ windowMs: 60 * 60 * 1000, max: env.REGISTER_MAX_PER_IP_HOUR, keyFn: () => 'register', message: 'Too many registrations from this address.' }),
    rateLimit({ windowMs: 60 * 60 * 1000, max: env.REGISTER_MAX_PER_HOUR, includeIp: false, keyFn: () => 'register-all', message: 'Too many registrations right now.' }),
    express.json({ limit: '8kb' }),
    async (req, res) => {
        try {
            const result = await require('../services/registrationService').register(req.body);
            if (result.body?.retryAfter) res.setHeader('Retry-After', String(result.body.retryAfter));
            res.setHeader('Cache-Control', 'no-store');
            json(res, result);
        } catch (err) {
            sendServerError(res, err, { context: 'Device register' });
        }
    });

/**
 * GET /time (CONTRACTS 2a.6): clock, timezone (+ POSIX TZ) and the public address FlyBot saw. No
 * auth (it works before registration); a camera that sends its serial and token gets its farm or
 * GPS timezone, anyone else the timezone of their IP (offline lookup) or the default.
 */
router.get('/time', rateLimit({ windowMs: 60 * 1000, max: 30, keyFn: () => 'time', message: 'Too many requests.' }), async (req, res) => {
    try {
        const camera = req.get('X-Device-Token') ? await deviceService.authenticate(req.get('X-Device-Serial'), req.get('X-Device-Token')) : null;
        res.setHeader('Cache-Control', 'no-store');
        res.json(await require('../services/timezoneService').deviceTime({ camera, ip: req.ip }));
    } catch (err) {
        sendServerError(res, err, { context: 'Device time' });
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

/**
 * GET /firmware/:id?sn&exp&sig: a firmware image, for the signed link GET /ota handed the camera (or a camera that
 * sends its own token), while it has an open update to that build (services/firmwareService.js).
 */
router.get('/firmware/:id', rateLimit({ windowMs: 60 * 1000, max: 20, keyFn: () => 'firmware', message: 'Too many requests.' }), async (req, res) => {
    try {
        const firmware = require('../services/firmwareService');
        const camera = req.get('X-Device-Token') ? await deviceService.authenticate(req.get('X-Device-Serial'), req.get('X-Device-Token')) : null;
        const q = req.query || {};
        const access = await firmware.authorizeDownload(req.params.id, { sn: q.sn, exp: q.exp, sig: q.sig }, camera);
        if (access.status !== 200) return res.status(access.status).json({ ok: false, error: access.status === 401 ? 'unauthorized' : 'not_found' });
        const object = await require('../services/s3Service').getS3Object(access.firmware.s3Key);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(access.firmware.size));
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Fw-Sha256', access.firmware.sha256);
        const body = object.Body;
        if (body?.pipe) return body.pipe(res);
        if (body?.transformToByteArray) return res.end(Buffer.from(await body.transformToByteArray()));
        res.end(Buffer.from(body || []));
    } catch (err) {
        sendServerError(res, err, { context: 'Firmware download' });
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

// The build of this camera's open firmware update (or the env offer); 204 when there is none. Never 401 for a
// known camera: the firmware takes a 401 here as "my registration is gone"
/**
 * POST /logs { v, kind: crash | diag, fw, uptimeMs, lines, crash }: a camera that cannot reach MQTT sends its crash
 * report, or a short diagnosis with its latest log, over HTTPS (services/cameraLogService.js). Secrets are removed on
 * the camera. A few a minute per camera.
 */
router.post('/logs', rateLimit({ windowMs: 60 * 1000, max: 4, includeIp: false, keyFn: serialKey, message: 'Too many reports for this camera.' }),
    express.json({ limit: '64kb' }), async (req, res) => {
        try {
            json(res, await require('../services/cameraLogService').deviceReport(req.camera, req.body));
        } catch (err) {
            sendServerError(res, err, { context: 'Device logs' });
        }
    });

router.get('/ota', async (req, res) => {
    try {
        const manifest = await require('../services/firmwareService').offerFor(req.camera);
        if (!manifest) return res.status(204).end();
        res.setHeader('Cache-Control', 'no-store');
        res.json(manifest);
    } catch (err) {
        console.error(`❌ OTA offer (${req.camera?.deviceSerial}):`, err.message);
        res.status(204).end();
    }
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
