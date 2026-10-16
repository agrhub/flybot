// Local FlyBot for the FlyBot Sentinel integration (docs/flybot-pr-sentinel.md, flybot-sentinel T3.2).
//
// The real app on an in-memory MongoDB with the two EZVIZ lure traps (BE4089629, BE4111159), the excluded
// camera AC6527557 and one sticky trap (BC0001). Nothing external is called: cron is off, every key of .env is
// blanked, the EZVIZ capture returns a synthetic trap photo, the cloud AI is a stub, Telegram is off.
//
//   API         http://127.0.0.1:3014   (/api/v1 public API, /api/sentinel signed API, /api/ai/chat/*)
//   Fake S3     http://127.0.0.1:3015   path-style GET /<bucket>/<key> and ListObjectsV2 over the same
//                                       in-memory objects the app writes (stand-in for the MinIO the
//                                       flybot-poller reads; signatures are not checked)
//               GET /__webhooks          snapshot_analyzed deliveries to https://sentinel-receiver.test/flybot/webhook
//                                       (recorded instead of sent: raw body + X-FlyBot-* headers)
//
// It writes the throwaway credentials of this run (API key fbk_..., SENTINEL_API_SECRET, webhook secret, a
// manager JWT) to $FLYBOT_DEV_OUT (default: <tmp>/flybot-sentinel-dev.json). They exist only in this process.
//
//   node tools/sentinel/dev-server.js                       (AI_PROVIDER=roboflow stub: photos arrive analyzed)
//   AI_PROVIDER=sentinel node tools/sentinel/dev-server.js  (photos wait for POST /api/sentinel/analysis)
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

const SERVER = path.resolve(__dirname, '../../server');
const req = (p) => require(p.startsWith('node_modules/') ? require.resolve(p.slice(13), { paths: [SERVER] }) : path.join(SERVER, p));

const keepProvider = process.env.AI_PROVIDER;
for (const file of [path.join(SERVER, '.env'), path.join(SERVER, '../.env')]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const key = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
        if (key) process.env[key] = '';
    }
}
const API_PORT = Number(process.env.FLYBOT_DEV_PORT) || 3014;
const S3_PORT = Number(process.env.FLYBOT_DEV_S3_PORT) || 3015;
const BUCKET = 'ezviz-manager';
const OUT = process.env.FLYBOT_DEV_OUT || path.join(os.tmpdir(), 'flybot-sentinel-dev.json');
const SENTINEL_SECRET = crypto.randomBytes(32).toString('hex');
Object.assign(process.env, {
    NODE_ENV: 'development',
    PORT: String(API_PORT),
    ENABLE_CRON: 'false',
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    MONGO_URI: 'mongodb://127.0.0.1:1/unused',
    APP_BASE_URL: `http://127.0.0.1:${API_PORT}`,
    S3_ENDPOINT: `http://127.0.0.1:${S3_PORT}`,
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: 'dev',
    S3_SECRET_KEY: 'dev',
    S3_BUCKET_NAME: BUCKET,
    SENTINEL_API_SECRET: SENTINEL_SECRET,
    SENTINEL_CAPTURE_BUDGET: '20',
    AI_PROVIDER: keepProvider || 'roboflow',
    TELEGRAM_BOT_TOKEN: '',
    // EZVIZ is stubbed below; the app only checks that these are set
    APP_KEY: 'dev',
    SECRET_KEY: 'dev'
});

const { Readable } = require('stream');
const mongoose = req('node_modules/mongoose');
const jwt = req('node_modules/jsonwebtoken');
const axios = req('node_modules/axios');
const { MongoMemoryServer } = req('node_modules/mongodb-memory-server-core');
const env = req('src/config/env');
const models = req('src/models');
const { s3Client } = req('src/config/s3');
const ezvizService = req('src/services/ezvizService');
const aiService = req('src/services/aiService');
const webhookService = req('src/services/webhookService');
const trapImage = require('../media/trapImage');

// ---------- Objects (the app's S3 and the fake MinIO share them) ----------
const objects = new Map();
s3Client.send = async (command) => {
    const name = command?.constructor?.name;
    const { Key, Body } = command?.input || {};
    if (name === 'PutObjectCommand') { objects.set(Key, Buffer.isBuffer(Body) ? Body : Buffer.from(Body)); return {}; }
    if (name === 'DeleteObjectCommand') { objects.delete(Key); return {}; }
    if (name === 'GetObjectCommand' || name === 'HeadObjectCommand') {
        const body = objects.get(Key);
        if (!body) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
        return { ContentType: 'image/jpeg', ContentLength: body.length, Body: Readable.from([body]) };
    }
    return {};
};

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const deliveries = [];
let flies = 2;
http.createServer((rq, rs) => {
    const u = new URL(rq.url, `http://127.0.0.1:${S3_PORT}`);
    if (u.pathname === '/__webhooks') {
        rs.writeHead(200, { 'Content-Type': 'application/json' });
        return rs.end(JSON.stringify(deliveries));
    }
    const cam = /^\/__camera\/([A-Za-z0-9]+)\.jpg$/.exec(u.pathname);
    if (cam) {
        // The camera's picture: a few more flies each time
        flies = (flies + 3) % 25;
        rs.writeHead(200, { 'Content-Type': 'image/jpeg' });
        return rs.end(trapImage.render({ seed: Date.now() % 100000, flies }).jpeg);
    }
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] !== BUCKET) { rs.writeHead(404); return rs.end('NoSuchBucket'); }
    if (parts.length === 1 && u.searchParams.get('list-type') === '2') {
        const prefix = u.searchParams.get('prefix') || '';
        const after = u.searchParams.get('start-after') || '';
        const keys = [...objects.keys()].filter(k => k.startsWith(prefix) && k > after).sort().slice(0, 1000);
        rs.writeHead(200, { 'Content-Type': 'application/xml' });
        return rs.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${BUCKET}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount><IsTruncated>false</IsTruncated>${keys.map(k => `<Contents><Key>${xml(k)}</Key><Size>${objects.get(k).length}</Size></Contents>`).join('')}</ListBucketResult>`);
    }
    const body = objects.get(decodeURIComponent(parts.slice(1).join('/')));
    if (!body) { rs.writeHead(404); return rs.end('NoSuchKey'); }
    rs.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': body.length });
    rs.end(body);
}).listen(S3_PORT, '127.0.0.1');

// ---------- EZVIZ capture, cloud AI and the webhook receiver, stubbed ----------
ezvizService.captureDevice = async (serial) => ({ code: '200', data: { picUrl: `http://127.0.0.1:${S3_PORT}/__camera/${serial}.jpg` } });
aiService.analyzeSnapshot = async (base64, snapshotId) => {
    if (aiService.isSentinelMode()) return false;
    const n = Math.floor(Math.random() * 6);
    const boxes = Array.from({ length: n }, (_, i) => ({ name: 'fruit fly', confidence: 0.9, bbox: [100 + i * 40, 100, 128 + i * 40, 128] }));
    await models.Snapshot.updateOne({ _id: snapshotId }, { $set: {
        aiProcessed: true, aiProvider: 'roboflow', pestCount: n,
        'aiResults.detected': n > 0, 'aiResults.summary': { 'fruit fly': n }, 'aiResults.insects': boxes
    } });
    return true;
};
const RECEIVER = 'https://sentinel-receiver.test/flybot/webhook';
const realPost = axios.post;
axios.post = async (url, body, config = {}) => {
    if (url !== RECEIVER) return realPost.call(axios, url, body, config);
    deliveries.push({ at: new Date().toISOString(), headers: config.headers, body });
    return { status: 200, data: { ok: true } };
};

// ---------- Seed ----------
const MIN = 60 * 1000;
async function seed() {
    const user = (email, role) => models.User.create({ email, name: email.split('@')[0], role, password: 'x'.repeat(60), emailVerified: true, language: 'en' });
    await user('admin@flybot.test', 'admin');
    const owner = await user('owner@flybot.test', 'manager');
    const farm = await models.Farm.create({ ownerId: owner._id, name: 'Orchard (dev)' });
    const plot = await models.Plot.create({ farmId: farm._id, name: 'Plot L', color: '#3ecf8e' });
    const cams = [
        { deviceSerial: 'BE4089629', deviceName: 'Lure trap 1', trapKind: 'lure' },
        { deviceSerial: 'BE4111159', deviceName: 'Lure trap 2', trapKind: 'lure' },
        { deviceSerial: 'AC6527557', deviceName: 'Gravity01 (excluded)', trapKind: 'sticky' },
        { deviceSerial: 'BC0001', deviceName: 'Sticky trap (dev)', trapKind: 'sticky' }
    ];
    for (const c of cams) {
        await models.Camera.create({ ...c, userId: owner._id, status: 1, farmId: farm._id, plotId: plot._id, latitude: 10.35, longitude: 106.36,
            alertThreshold: 15, captureIntervalMinutes: 30, captureDaytimeOnly: false, sharedWith: [] });
    }
    // Six hours of analyzed photos every 30 minutes, stored under the production key layout
    const now = Date.now();
    for (const c of cams) {
        for (let m = 360; m >= 30; m -= 30) {
            const ts = now - m * MIN;
            const n = (m / 30) % 4;
            const key = `snapshots/${c.deviceSerial}/${c.deviceSerial}_${ts}.jpg`;
            objects.set(key, trapImage.render({ seed: ts % 100000, flies: n }).jpeg);
            await models.Snapshot.create({ deviceSerial: c.deviceSerial, s3Key: key, imageUrl: `/${key}`, createdAt: new Date(ts + 140),
                aiProcessed: true, aiProvider: 'roboflow', pestCount: n, aiResults: { detected: n > 0, summary: { 'fruit fly': n }, insects: [] } });
        }
    }
    const apiKey = `fbk_${crypto.randomBytes(24).toString('base64url')}`;
    await models.ApiKey.create({ userId: owner._id, name: 'sentinel-poller (dev)', prefix: apiKey.slice(0, 12), hash: crypto.createHash('sha256').update(apiKey).digest('hex') });
    const webhookSecret = webhookService.newSecret();
    await models.Webhook.create({ userId: owner._id, url: RECEIVER, secret: webhookSecret, events: ['snapshot_analyzed'] });
    return { owner, apiKey, webhookSecret };
}

(async () => {
    const dbPath = process.env.FLYBOT_DEV_DB || path.join(os.tmpdir(), 'flybot-sentinel-dev-db');
    fs.rmSync(dbPath, { recursive: true, force: true });
    fs.mkdirSync(dbPath, { recursive: true });
    const mongod = await MongoMemoryServer.create({ instance: { dbPath } });
    await mongoose.connect(mongod.getUri());
    await Promise.all(Object.values(models).map(m => m.syncIndexes()));
    const { owner, apiKey, webhookSecret } = await seed();
    const { app } = req('src/app');
    app.listen(API_PORT, '127.0.0.1', () => {
        const token = jwt.sign({ id: String(owner._id), v: 0 }, env.JWT_SECRET, { expiresIn: '12h' });
        fs.writeFileSync(OUT, JSON.stringify({
            apiUrl: `http://127.0.0.1:${API_PORT}`, storageEndpoint: `http://127.0.0.1:${S3_PORT}`, bucket: BUCKET,
            apiKey, sentinelSecret: SENTINEL_SECRET, webhookSecret, webhookLog: `http://127.0.0.1:${S3_PORT}/__webhooks`,
            ownerToken: token, aiProvider: env.AI_PROVIDER
        }, null, 2));
        console.log(`FlyBot dev for Sentinel on :${API_PORT} (fake S3 :${S3_PORT}, AI_PROVIDER=${env.AI_PROVIDER}); credentials in ${OUT}`);
    });
})().catch((err) => { console.error(err); process.exit(1); });
