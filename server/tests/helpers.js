/**
 * Test harness: boots the Express app in-process with MongoDB models, S3 and email stubbed,
 * so tests never touch the real database, bucket, mail server, EZVIZ or AI APIs (and no cron jobs start).
 * Models are backed by a small in-memory store implementing only the queries the app uses.
 */
const { Readable } = require('stream');

// Must be set before config/env is loaded; dotenv never overrides existing variables
process.env.JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
process.env.CORS_ORIGINS = '';
process.env.ALLOW_REGISTRATION = 'true';
process.env.APP_BASE_URL = 'https://app.example.test';
process.env.SMTP_HOST = '';
// Lets tests vary the client IP with X-Forwarded-For so per-IP rate limits do not leak between tests
process.env.TRUST_PROXY = 'true';

const jwt = require('jsonwebtoken');
const env = require('../src/config/env');
const models = require('../src/models');
const { s3Client } = require('../src/config/s3');
const mailService = require('../src/services/mailService');

const ALICE = '64b000000000000000000001';
const BOB = '64b000000000000000000002';

// ---------- In-memory store ----------
const store = {
    users: new Map(),
    cameras: [],
    authTokens: [],
    notifications: [],
    sessions: []
};
const sentMails = [];
let nextId = 1;
const newId = () => (0x64c000000000000000000000n + BigInt(nextId++)).toString(16);

function makeDoc(data) {
    const doc = { ...data };
    Object.defineProperty(doc, 'save', { value: async () => doc, enumerable: false });
    Object.defineProperty(doc, 'set', {
        value: (path, value) => {
            const parts = path.split('.');
            let node = doc;
            for (const p of parts.slice(0, -1)) node = node[p] = node[p] || {};
            node[parts[parts.length - 1]] = value;
        },
        enumerable: false
    });
    return doc;
}

function resetStore() {
    store.users.clear();
    for (const id of [ALICE, BOB]) {
        store.users.set(id, makeDoc({
            _id: id,
            email: `${id}@example.test`,
            password: '',
            name: id === ALICE ? 'Alice' : 'Bob',
            // Alice owns and manages CAMA; Bob is a viewer
            role: id === ALICE ? 'manager' : 'user',
            emailVerified: true,
            language: 'en',
            tokenVersion: 0,
            notificationPrefs: { email: true }
        }));
    }
    store.cameras = [
        makeDoc({ userId: ALICE, deviceSerial: 'CAMA', deviceName: 'Mango Lot A', validateCode: '', status: 1, alertThreshold: 15 })
    ];
    store.authTokens = [];
    store.notifications = [];
    store.sessions = [];
    sentMails.length = 0;
}
resetStore();

// A thenable query result supporting the chained calls the app uses
function query(resultFn) {
    const q = {
        then: (resolve, reject) => Promise.resolve().then(resultFn).then(resolve, reject),
        select: () => q,
        sort: () => q,
        limit: () => q,
        skip: () => q,
        populate: () => q,
        collation: () => q,
        lean: () => q
    };
    return q;
}

const sameId = (a, b) => String(a) === String(b);

// User
models.User.prototype.save = async function () {
    store.users.set(String(this._id), makeDoc(this.toObject()));
    return this;
};
models.User.findById = (id) => query(() => store.users.get(String(id)) || null);
const userMatches = (u, filter) =>
    (filter._id === undefined || (typeof filter._id === 'object' && filter._id.$ne !== undefined
        ? !sameId(u._id, filter._id.$ne) : sameId(u._id, filter._id))) &&
    (filter['telegram.chatId'] === undefined || u.telegram?.chatId === filter['telegram.chatId']);
const applyUserUpdate = (u, update) => {
    Object.assign(u, update.$set || {});
    for (const key of Object.keys(update.$unset || {})) delete u[key];
};
models.User.updateOne = async (filter, update) => {
    const u = [...store.users.values()].find(x => userMatches(x, filter));
    if (u) applyUserUpdate(u, update);
    return { modifiedCount: u ? 1 : 0 };
};
models.User.updateMany = async (filter, update) => {
    const list = [...store.users.values()].filter(x => userMatches(x, filter));
    list.forEach(u => applyUserUpdate(u, update));
    return { modifiedCount: list.length };
};
models.User.countDocuments = async () => store.users.size;
models.User.findOne = ({ email }) => query(() =>
    [...store.users.values()].find(u => u.email.toLowerCase() === String(email).toLowerCase()) || null);

// Camera
// Supports the filters the access rules use: owner, shared-with, $or of those, device serial
const cameraMatches = (c, filter = {}) =>
    (filter._id === undefined || (filter._id === null ? false : sameId(c._id, filter._id))) &&
    (filter.$or === undefined || filter.$or.some(sub => cameraMatches(c, sub))) &&
    (filter.userId === undefined || (typeof filter.userId === 'object' ? c.userId != null : sameId(c.userId, filter.userId))) &&
    (filter['sharedWith.userId'] === undefined || (c.sharedWith || []).some(sh => sameId(sh.userId, filter['sharedWith.userId']))) &&
    (filter.deviceSerial === undefined || (typeof filter.deviceSerial === 'object'
        ? (filter.deviceSerial.$in || []).includes(c.deviceSerial)
        : c.deviceSerial === filter.deviceSerial));
const camerasMatching = (filter = {}) => store.cameras.filter(c => cameraMatches(c, filter));
models.Camera.exists = async (filter) => (camerasMatching(filter).length ? { _id: 1 } : null);
models.Camera.findOne = (filter) => query(() => camerasMatching(filter)[0] || null);
models.Camera.find = (filter) => query(() => camerasMatching(filter));
models.Camera.updateMany = async (filter, update) => {
    camerasMatching(filter).forEach(c => Object.assign(c, update.$set || {}));
};

// Snapshot
models.Snapshot.find = () => query(() => []);

// AuditLog: entries are not stored in the stub store
models.AuditLog.create = async (data) => data;

// SystemSetting: nothing saved, so the environment defaults apply
models.SystemSetting.findOne = () => query(() => null);

// AuthToken
models.AuthToken.deleteMany = async ({ userId, type }) => {
    store.authTokens = store.authTokens.filter(t => !(sameId(t.userId, userId) && t.type === type && !t.usedAt));
};
models.AuthToken.create = async (data) => {
    const doc = { _id: newId(), usedAt: null, ...data };
    store.authTokens.push(doc);
    return doc;
};
models.AuthToken.findOneAndUpdate = async (filter, update) => {
    const now = filter.expiresAt.$gt;
    const doc = store.authTokens.find(t =>
        t.tokenHash === filter.tokenHash && t.type === filter.type && !t.usedAt && t.expiresAt > now);
    if (!doc) return null;
    Object.assign(doc, update.$set);
    return doc;
};

// Notification
const notificationMatches = (n, filter) =>
    sameId(n.userId, filter.userId) &&
    (filter.type === undefined || n.type === filter.type) &&
    (filter.deviceSerial === undefined || n.deviceSerial === filter.deviceSerial) &&
    (filter.read === undefined || n.read === filter.read) &&
    (filter._id === undefined || filter._id.$in.some(id => sameId(id, n._id))) &&
    (filter.createdAt === undefined ||
        ((!filter.createdAt.$gte || n.createdAt >= filter.createdAt.$gte) &&
         (!filter.createdAt.$lt || n.createdAt < filter.createdAt.$lt)));
models.Notification.exists = async (filter) => (store.notifications.some(n => notificationMatches(n, filter)) ? { _id: 1 } : null);
models.Notification.create = async (data) => {
    const doc = { _id: newId(), read: false, createdAt: new Date(), ...data };
    store.notifications.push(doc);
    return doc;
};
models.Notification.find = (filter) => query(() =>
    store.notifications.filter(n => notificationMatches(n, filter)).sort((a, b) => b.createdAt - a.createdAt));
models.Notification.countDocuments = async (filter) => store.notifications.filter(n => notificationMatches(n, filter)).length;
models.Notification.updateMany = async (filter, update) => {
    store.notifications.filter(n => notificationMatches(n, filter)).forEach(n => Object.assign(n, update.$set));
};

// Session
const sessionMatches = (sess, filter) =>
    (filter._id === undefined || (typeof filter._id === 'object' && filter._id.$ne !== undefined
        ? !sameId(sess._id, filter._id.$ne) : sameId(sess._id, filter._id))) &&
    (filter.userId === undefined || sameId(sess.userId, filter.userId)) &&
    (filter.revokedAt === undefined || (filter.revokedAt === null ? !sess.revokedAt : true)) &&
    (filter.expiresAt === undefined || sess.expiresAt > filter.expiresAt.$gt);
models.Session.create = async (data) => {
    const doc = { _id: newId(), createdAt: new Date(), lastSeenAt: new Date(), revokedAt: null, ...data };
    store.sessions.push(doc);
    return doc;
};
models.Session.findById = async (id) => store.sessions.find(sess => sameId(sess._id, id)) || null;
models.Session.find = (filter) => query(() => store.sessions.filter(sess => sessionMatches(sess, filter)));
models.Session.updateOne = async (filter, update) => {
    const doc = store.sessions.find(sess => sessionMatches(sess, filter));
    if (doc) Object.assign(doc, update.$set);
};
models.Session.updateMany = async (filter, update) => {
    store.sessions.filter(sess => sessionMatches(sess, filter)).forEach(sess => Object.assign(sess, update.$set));
};
models.Session.findOneAndUpdate = async (filter, update) => {
    const doc = store.sessions.find(sess => sessionMatches(sess, filter));
    if (doc) Object.assign(doc, update.$set);
    return doc || null;
};

// S3
s3Client.send = async () => ({
    ContentType: 'image/jpeg',
    Body: Readable.from([Buffer.from('JPEGDATA')])
});

// Email: capture instead of sending (patched before controllers load)
mailService.queueMail = (message) => sentMails.push(message);
mailService.sendMail = async (message) => { sentMails.push(message); return {}; };

const { app } = require('../src/app');

function token(userId, secret = env.JWT_SECRET, version) {
    const v = version ?? store.users.get(userId)?.tokenVersion ?? 0;
    return jwt.sign({ id: userId, v }, secret, { expiresIn: '1h' });
}

/**
 * Start the app on a random port; returns { request, close }.
 */
async function startApp() {
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    function request(path, { method = 'GET', body, headers = {} } = {}) {
        const init = { method, headers: { ...headers } };
        if (body !== undefined) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }
        return fetch(base + path, init);
    }

    return {
        base,
        request,
        close: () => new Promise(resolve => {
            server.closeAllConnections?.();
            server.close(resolve);
        })
    };
}

const bearer = (userId) => ({ Authorization: `Bearer ${token(userId)}` });
const cookie = (userId) => ({ Cookie: `${env.AUTH_COOKIE_NAME}=${token(userId)}` });

// Wait for background work (setImmediate + queued promises)
const flush = () => new Promise(resolve => setTimeout(resolve, 50));

module.exports = {
    ALICE,
    BOB,
    store,
    sentMails,
    resetStore,
    token,
    bearer,
    cookie,
    flush,
    startApp
};
