// Local run of the simulated demo farm (server/src/services/demoSim.js) against the REAL vision
// handler: in-memory MongoDB, photos in a folder instead of S3, the flybot-aws vision Lambda run
// locally (uv run python -m sentinel.lambda_local, POST http://127.0.0.1:9001/invoke).
//
//   FLYBOT_SIM_SET="<flybot-aws>/data/synth/demo-30d;<flybot-aws>/data/synth/pool" FLYBOT_SIM_STORE=<empty folder> node sim-demo.js
//   (then node demo-client.mjs: http://localhost:3010)
//
// FLYBOT_SIM_DAYS (default 5): the last days to simulate up to now; VISION_LAMBDA_URL (default
// http://127.0.0.1:9001/invoke). One photo at a time: lambda_local serves requests on threads that
// share one OpenCV DNN net, which is not thread-safe (on AWS each Lambda instance takes one request). Accounts: judge@flybot.test (a visitor, created today) and
// admin@flybot.test; their sign-in tokens go to sim-tokens.json. Nothing real is touched: every key
// of the real .env is blanked.
const path = require('path');
const fs = require('fs');
const http = require('http');
const SERVER = path.resolve(__dirname, '../../server');
const req = (p) => require(p.startsWith('node_modules/') ? require.resolve(p.slice(13), { paths: [SERVER] }) : path.join(SERVER, p));

for (const file of [path.join(SERVER, '.env'), path.join(SERVER, '../.env')]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const key = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
        if (key && key !== 'VISION_LAMBDA_URL') process.env[key] = '';
    }
}
const SET = process.env.FLYBOT_SIM_SET;
const STORE = process.env.FLYBOT_SIM_STORE;
if (!SET || !STORE) {
    console.error('Set FLYBOT_SIM_SET (a synthetic set with manifest.json) and FLYBOT_SIM_STORE (a folder for the photos).');
    process.exit(2);
}
const API_PORT = Number(process.env.DEMO_API_PORT) || 3013;
const CLIENT_PORT = Number(process.env.DEMO_CLIENT_PORT) || 3010;
const FILES_PORT = Number(process.env.FLYBOT_SIM_FILES_PORT) || 3019;
Object.assign(process.env, {
    NODE_ENV: 'development',
    PORT: String(API_PORT),
    JWT_SECRET: 'sim-secret-'.padEnd(48, 'x'),
    MONGO_URI: 'mongodb://127.0.0.1:1/unused',
    CORS_ORIGINS: `http://localhost:${CLIENT_PORT}`,
    ALLOW_REGISTRATION: 'true',
    APP_BASE_URL: `http://localhost:${CLIENT_PORT}`,
    SMTP_HOST: '',
    TELEGRAM_BOT_TOKEN: '',
    S3_ACCESS_KEY_ID: 'sim',
    S3_SECRET_ACCESS_KEY: 'sim',
    AI_PROVIDER: 'opencv-lambda',
    PHOTOS_BY_REFERENCE: 'false',
    VISION_LAMBDA_URL: process.env.VISION_LAMBDA_URL || 'http://127.0.0.1:9001/invoke',
    DEMO_VIEW_ENABLED: 'true',
    DEMO_VIEW_SIMULATED: 'true'
});

const mongoose = req('node_modules/mongoose');
const jwt = req('node_modules/jsonwebtoken');
const bcrypt = req('node_modules/bcryptjs');
const { MongoMemoryServer } = req('node_modules/mongodb-memory-server-core');
const env = req('src/config/env');
const models = req('src/models');
const s3Service = req('src/services/s3Service');
const mailService = req('src/services/mailService');
mailService.queueMail = (m) => console.log('[mail]', m.to, '-', m.subject);
mailService.sendMail = async () => ({});

// The bucket is a folder; the Lambda reads photos over http from it
const fileOf = (key) => path.join(STORE, ...String(key).split('/'));
s3Service.uploadSnapshot = async (key, buffer) => {
    fs.mkdirSync(path.dirname(fileOf(key)), { recursive: true });
    fs.writeFileSync(fileOf(key), buffer);
    return {};
};
s3Service.readS3Buffer = async (key) => fs.readFileSync(fileOf(key));
s3Service.getS3Object = async (key) => ({ ContentType: 'image/jpeg', Body: fs.createReadStream(fileOf(key)) });
s3Service.deleteS3Object = async (key) => fs.rmSync(fileOf(key), { force: true });
s3Service.getSignedDownloadUrl = async (key) => `http://127.0.0.1:${FILES_PORT}/${key}`;
const { s3Client } = req('src/config/s3');
s3Client.send = async (command) => ({ ContentType: 'image/jpeg', Body: fs.createReadStream(fileOf(command?.input?.Key)) });

const { app } = req('src/app');
const demoSim = req('src/services/demoSim');

(async () => {
    fs.mkdirSync(STORE, { recursive: true });
    http.createServer((rq, rs) => {
        const file = fileOf(decodeURIComponent(rq.url.split('?')[0].slice(1)));
        if (!file.startsWith(path.resolve(STORE)) || !fs.existsSync(file)) { rs.writeHead(404); return rs.end(); }
        rs.writeHead(200, { 'Content-Type': 'image/jpeg' });
        fs.createReadStream(file).pipe(rs);
    }).listen(FILES_PORT, '127.0.0.1');

    const dbPath = process.env.FLYBOT_DEMO_DB || path.join(require('os').tmpdir(), 'flybot-sim-db');
    fs.rmSync(dbPath, { recursive: true, force: true });
    fs.mkdirSync(dbPath, { recursive: true });
    const mongod = await MongoMemoryServer.create({ instance: { dbPath } });
    await mongoose.connect(mongod.getUri());
    await Promise.all(Object.values(models).map(m => m.syncIndexes()));

    const password = await bcrypt.hash('judge-demo-1', 4);
    const admin = await models.User.create({ email: 'admin@flybot.test', name: 'Admin', role: 'admin', password, emailVerified: true, language: 'vi', createdAt: new Date('2025-01-01') });
    const judge = await models.User.create({ email: 'judge@flybot.test', name: 'Judge', role: 'user', password, emailVerified: true, language: 'en' });

    // Several sets (demo-30d, demo-ahead, pool) separated by ";"
    console.log('Pool:', JSON.stringify(await demoSim.uploadPool({ dirs: SET.split(';').map(s => s.trim()).filter(Boolean), dryRun: false })));
    const days = Number(process.env.FLYBOT_SIM_DAYS) || 5;
    const now = new Date();
    const from = new Date(now.getTime() - (days - 1) * 86400000 + 7 * 3600000).toISOString().slice(0, 10);
    const t0 = Date.now();
    const result = await demoSim.simulate({ until: now, from, dryRun: false, concurrency: 1 });
    console.log('Simulated:', JSON.stringify({ ...result, seconds: Math.round((Date.now() - t0) / 1000) }));

    app.listen(API_PORT, () => {
        const tokens = Object.fromEntries([['admin', admin], ['judge', judge]].map(([k, u]) => [k, {
            token: jwt.sign({ id: String(u._id), v: 0 }, env.JWT_SECRET, { expiresIn: '12h' }),
            user: { id: String(u._id), email: u.email, name: u.name, role: u.role, emailVerified: true, language: u.language }
        }]));
        fs.writeFileSync(path.join(__dirname, 'sim-tokens.json'), JSON.stringify(tokens, null, 2));
        console.log(`Simulated demo API on :${API_PORT} (judge@flybot.test / judge-demo-1)`);
    });
})().catch((err) => {
    console.error('❌', err);
    process.exit(1);
});
