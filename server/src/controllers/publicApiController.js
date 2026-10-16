const crypto = require('crypto');
const mongoose = require('mongoose');
const { ApiKey, User, Snapshot, Notification } = require('../models');
const { roleOf } = require('../constants/roles');
const { viewableCameras, findViewableCamera } = require('../utils/ownership');
const { sendServerError } = require('../utils/http');
const { countPests } = require('../services/notificationService');
const { latestProcessedByCamera } = require('../services/snapshotQueries');
const dailyStats = require('../services/dailyStats');
const { thresholdOf } = require('../constants/risk');

/**
 * Public read-only API (/api/v1), authenticated with an API key:
 *   Authorization: Bearer fbk_...   or   X-API-Key: fbk_...
 * The key acts as its owner, with view access only.
 */
const KEY_PREFIX = 'fbk_';
const LAST_USED_THROTTLE_MS = 60 * 1000;

const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');
const toObject = (m) => (m instanceof Map ? Object.fromEntries(m) : (m || {}));

function readKey(req) {
    const header = req.headers['x-api-key'];
    if (typeof header === 'string' && header.startsWith(KEY_PREFIX)) return header.trim();
    const auth = req.headers.authorization;
    if (auth?.startsWith(`Bearer ${KEY_PREFIX}`)) return auth.slice(7).trim();
    return null;
}

async function authenticateApiKey(req, res, next) {
    try {
        const key = readKey(req);
        if (!key) return res.status(401).json({ success: false, message: 'Missing API key (Authorization: Bearer fbk_... or X-API-Key).' });
        const apiKey = await ApiKey.findOne({ hash: hashKey(key), revokedAt: null });
        const user = apiKey ? await User.findById(apiKey.userId).select('email role disabled') : null;
        // A key stops working when its account is disabled (keys are made only on plans with apiAndWebhooks)
        if (!apiKey || !user || user.disabled) {
            return res.status(401).json({ success: false, message: 'Invalid or revoked API key.' });
        }
        if (!apiKey.lastUsedAt || Date.now() - apiKey.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
            ApiKey.updateOne({ _id: apiKey._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
        }
        req.user = { id: String(user._id), email: user.email, role: roleOf(user) };
        req.apiKeyId = String(apiKey._id);
        next();
    } catch (err) {
        sendServerError(res, err, { context: 'API key' });
    }
}

const cameraOut = (cam, latest) => ({
    deviceSerial: cam.deviceSerial,
    name: cam.deviceName,
    online: cam.status === 1,
    trapKind: cam.trapKind || 'sticky',
    latitude: Number.isFinite(cam.latitude) ? cam.latitude : null,
    longitude: Number.isFinite(cam.longitude) ? cam.longitude : null,
    alertThreshold: thresholdOf(cam),
    farmId: cam.farmId ? String(cam.farmId) : null,
    plotId: cam.plotId ? String(cam.plotId) : null,
    organizationId: cam.orgId ? String(cam.orgId) : null,
    latest: latest ? { at: latest.createdAt, count: countPests(toObject(latest.summary)), counts: toObject(latest.summary) } : null
});

/** GET /api/v1/me */
function me(req, res) {
    res.json({ success: true, data: { email: req.user.email, role: req.user.role } });
}

/** GET /api/v1/cameras */
async function listCameras(req, res) {
    try {
        const cameras = await viewableCameras(req.user).sort({ deviceName: 1 }).lean();
        const latest = await latestProcessedByCamera(cameras.map(c => c.deviceSerial));
        res.json({ success: true, data: cameras.map(c => cameraOut(c, latest.get(c.deviceSerial))) });
    } catch (err) {
        sendServerError(res, err, { context: 'API cameras' });
    }
}

async function loadCamera(req, res) {
    const camera = await findViewableCamera(req.user, String(req.params.serial || '')).lean();
    if (!camera) res.status(404).json({ success: false, message: 'Camera not found.' });
    return camera;
}

/** GET /api/v1/cameras/:serial */
async function getCamera(req, res) {
    try {
        const camera = await loadCamera(req, res);
        if (!camera) return;
        const latest = await latestProcessedByCamera([camera.deviceSerial]);
        res.json({ success: true, data: cameraOut(camera, latest.get(camera.deviceSerial)) });
    } catch (err) {
        sendServerError(res, err, { context: 'API camera' });
    }
}

/** GET /api/v1/cameras/:serial/daily?days=30: per-day rollup (farm time zone) */
async function dailyCounts(req, res) {
    try {
        const camera = await loadCamera(req, res);
        if (!camera) return;
        const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
        const rows = await dailyStats.rows([camera.deviceSerial], dailyStats.startKeyForDays(days));
        res.json({
            success: true,
            data: rows.map(r => ({
                day: r.day,
                scans: r.scans,
                peak: r.peak,
                total: r.total,
                species: (r.species || []).map(sp => ({ name: sp.name, peak: sp.peak, total: sp.total }))
            }))
        });
    } catch (err) {
        sendServerError(res, err, { context: 'API daily counts' });
    }
}

/** GET /api/v1/cameras/:serial/snapshots?limit=50&before=ISO: analyzed photos, newest first */
async function snapshots(req, res) {
    try {
        const camera = await loadCamera(req, res);
        if (!camera) return;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const filter = { deviceSerial: camera.deviceSerial, aiProcessed: true };
        if (req.query.before) {
            const before = new Date(String(req.query.before));
            if (Number.isNaN(before.getTime())) return res.status(400).json({ success: false, message: 'before must be an ISO date.' });
            filter.createdAt = { $lt: before };
        }
        const list = await Snapshot.find(filter).sort({ createdAt: -1 }).limit(limit)
            .select('createdAt aiResults.summary review.status quality.issues').lean();
        res.json({
            success: true,
            data: list.map(s => ({
                id: String(s._id),
                at: s.createdAt,
                count: countPests(toObject(s.aiResults?.summary)),
                counts: toObject(s.aiResults?.summary),
                reviewed: s.review?.status || null,
                imageIssues: s.quality?.issues || []
            }))
        });
    } catch (err) {
        sendServerError(res, err, { context: 'API snapshots' });
    }
}

/** GET /api/v1/alerts?since=ISO&limit=100: my notifications, newest first */
async function alerts(req, res) {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
        const filter = { userId: new mongoose.Types.ObjectId(req.user.id) };
        if (req.query.since) {
            const since = new Date(String(req.query.since));
            if (Number.isNaN(since.getTime())) return res.status(400).json({ success: false, message: 'since must be an ISO date.' });
            filter.createdAt = { $gt: since };
        }
        const list = await Notification.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
        res.json({
            success: true,
            data: list.map(n => ({ id: String(n._id), event: n.type, severity: n.severity, deviceSerial: n.deviceSerial || null, params: n.params || {}, createdAt: n.createdAt }))
        });
    } catch (err) {
        sendServerError(res, err, { context: 'API alerts' });
    }
}

module.exports = {
    KEY_PREFIX,
    hashKey,
    authenticateApiKey,
    me,
    listCameras,
    getCamera,
    dailyCounts,
    snapshots,
    alerts
};
