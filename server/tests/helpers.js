/**
 * Test harness: boots the Express app in-process with MongoDB models and S3 stubbed,
 * so tests never touch the real database, bucket, EZVIZ or AI APIs (and no cron jobs start).
 */
const { Readable } = require('stream');

// Must be set before config/env is loaded; dotenv never overrides existing variables
process.env.JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
process.env.CORS_ORIGINS = '';
process.env.ALLOW_REGISTRATION = 'true';

const jwt = require('jsonwebtoken');
const env = require('../src/config/env');
const models = require('../src/models');
const { s3Client } = require('../src/config/s3');

const ALICE = '64b000000000000000000001';
const BOB = '64b000000000000000000002';

// userId -> owned camera serials
const ownership = {
    [ALICE]: ['CAMA'],
    [BOB]: []
};
const ownedBy = (userId, serial) => (ownership[userId] || []).includes(serial);

models.User.findById = (id) => ({
    select: async () => (ownership[id] ? { _id: id, email: `${id}@example.test` } : null)
});
models.User.findOne = async () => null;
models.Camera.exists = async ({ userId, deviceSerial }) => (ownedBy(userId, deviceSerial) ? { _id: 1 } : null);
models.Camera.findOne = async ({ userId, deviceSerial }) =>
    ownedBy(userId, deviceSerial) ? { deviceSerial, validateCode: '', save: async () => {} } : null;
models.Camera.find = ({ userId } = {}) => {
    const docs = (ownership[userId] || []).map(deviceSerial => ({ deviceSerial, status: 1 }));
    const query = Promise.resolve(docs);
    query.select = async () => docs;
    query.limit = async () => docs;
    query.sort = () => query;
    return query;
};
models.Snapshot.find = () => ({ sort: () => ({ limit: async () => [] }) });

s3Client.send = async () => ({
    ContentType: 'image/jpeg',
    Body: Readable.from([Buffer.from('JPEGDATA')])
});

const { app } = require('../src/app');

function token(userId, secret = env.JWT_SECRET) {
    return jwt.sign({ id: userId }, secret, { expiresIn: '1h' });
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
        close: () => new Promise(resolve => server.close(resolve))
    };
}

const bearer = (userId) => ({ Authorization: `Bearer ${token(userId)}` });
const cookie = (userId) => ({ Cookie: `${env.AUTH_COOKIE_NAME}=${token(userId)}` });

module.exports = {
    ALICE,
    BOB,
    token,
    bearer,
    cookie,
    startApp
};
