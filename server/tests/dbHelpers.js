/**
 * Integration-test harness with a real (in-memory) MongoDB, for logic that depends on real
 * queries (sharing, roles, dashboards). External services (S3, email, EZVIZ, Telegram) are
 * stubbed. Each test file runs in its own process with its own database.
 */
const { Readable } = require('stream');

process.env.JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
process.env.CORS_ORIGINS = '';
process.env.ALLOW_REGISTRATION = 'true';
process.env.APP_BASE_URL = 'https://app.example.test';
process.env.SMTP_HOST = '';
process.env.TRUST_PROXY = 'true';
process.env.TELEGRAM_BOT_TOKEN = '';

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
const env = require('../src/config/env');
const models = require('../src/models');
const { s3Client } = require('../src/config/s3');
const mailService = require('../src/services/mailService');
const ezvizService = require('../src/services/ezvizService');

const sentMails = [];
mailService.queueMail = (message) => sentMails.push(message);
mailService.sendMail = async (message) => { sentMails.push(message); return {}; };
s3Client.send = async () => ({ ContentType: 'image/jpeg', Body: Readable.from([Buffer.from('JPEGDATA')]) });
ezvizService.getDeviceInfo = async (serial) => ({ code: '200', data: { deviceSerial: serial, deviceName: `EZVIZ ${serial}` } });
ezvizService.getLiveAddress = async () => ({ responseData: { code: '200', data: { url: 'https://example.test/live.m3u8', id: 'stream-1' } }, token: 't', areaDomain: 'https://open.example.test' });
ezvizService.disableLiveAddress = async () => ({ code: '200' });
ezvizService.syncCameraStatus = async () => {};

const { app } = require('../src/app');

let mongod;
let server;
let base;

async function startDb() {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await Promise.all(Object.values(models).map(m => m.syncIndexes()));
    server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
}

async function stopDb() {
    server?.closeAllConnections?.();
    await new Promise(resolve => (server ? server.close(resolve) : resolve()));
    await mongoose.disconnect();
    await mongod?.stop();
}

async function clearDb() {
    sentMails.length = 0;
    await Promise.all(Object.values(models).map(m => m.deleteMany({})));
}

let ipCounter = 0;
function request(path, { method = 'GET', body, headers = {}, as } = {}) {
    // A fresh client IP per request keeps per-IP rate limits out of the way
    const init = { method, headers: { 'X-Forwarded-For': `10.50.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`, ...headers } };
    if (as) init.headers.Authorization = `Bearer ${tokenFor(as)}`;
    if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    return fetch(base + path, init);
}

function tokenFor(user) {
    return jwt.sign({ id: String(user._id), v: user.tokenVersion || 0 }, env.JWT_SECRET, { expiresIn: '1h' });
}

let userCounter = 0;
async function createUser({ role = 'user', email, ...rest } = {}) {
    return models.User.create({
        email: email || `user${++userCounter}@example.test`,
        password: await bcrypt.hash('secret123', 4),
        role,
        emailVerified: true,
        ...rest
    });
}

async function createCamera(owner, { deviceSerial, ...rest } = {}) {
    return models.Camera.create({ userId: owner._id, deviceSerial: deviceSerial || `SN${++userCounter}`, deviceName: 'Trap', ...rest });
}

const json = async (res) => ({ status: res.status, body: await res.json() });

module.exports = {
    models,
    sentMails,
    startDb,
    stopDb,
    clearDb,
    request,
    tokenFor,
    createUser,
    createCamera,
    json
};
