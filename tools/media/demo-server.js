// Local UI demo: in-memory MongoDB, external services stubbed, seeded data. Port 3013.
const path = require('path');
const fs = require('fs');
const SERVER = path.resolve(__dirname, '../../server');
const req = (p) => require(p.startsWith('node_modules/') ? require.resolve(p.slice(13), { paths: [SERVER] }) : path.join(SERVER, p));

// Blank every key from the real .env so no real credentials or databases are used
for (const file of [path.join(SERVER, '.env'), path.join(SERVER, '../.env')]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const key = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
        if (key) process.env[key] = '';
    }
}
process.env.NODE_ENV = 'development';
process.env.PORT = '3013';
process.env.JWT_SECRET = 'demo-secret-'.padEnd(48, 'x');
process.env.MONGO_URI = 'mongodb://127.0.0.1:1/unused';
process.env.CORS_ORIGINS = 'http://localhost:3010';
process.env.ALLOW_REGISTRATION = 'true';
process.env.APP_BASE_URL = 'http://localhost:3010';
process.env.SMTP_HOST = '';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.S3_ACCESS_KEY_ID = 'demo';
process.env.S3_SECRET_ACCESS_KEY = 'demo';
process.env.EZVIZ_APP_KEY = 'demo';
process.env.EZVIZ_APP_SECRET = 'demo';
process.env.GEMINI_API_KEY = '';
process.env.OPENWEATHER_API_KEY = '';
{
    const keys = require(require.resolve('web-push', { paths: [SERVER] })).generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    process.env.VAPID_SUBJECT = 'mailto:demo@flybot.test';
}

const { Readable } = require('stream');
const mongoose = req('node_modules/mongoose');
const jwt = req('node_modules/jsonwebtoken');
const { MongoMemoryServer } = req('node_modules/mongodb-memory-server-core');
const env = req('src/config/env');
const models = req('src/models');
const { s3Client } = req('src/config/s3');
const mailService = req('src/services/mailService');
const ezvizService = req('src/services/ezvizService');

// A tiny gray JPEG for every snapshot
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const mails = [];
mailService.queueMail = (m) => { mails.push(m); console.log('[mail]', m.to, '-', m.subject); };
mailService.sendMail = async (m) => { mails.push(m); return {}; };
s3Client.send = async () => ({ ContentType: 'image/jpeg', Body: Readable.from([JPEG]) });
ezvizService.getDeviceInfo = async (serial) => ({ code: '200', data: { deviceSerial: serial, deviceName: `EZVIZ ${serial}` } });
ezvizService.addCameraToEzviz = async (serial) => ({ code: '200', data: { deviceSerial: serial } });
ezvizService.getLiveAddress = async () => ({ responseData: { code: '500', msg: 'Demo: no live stream' } });
ezvizService.disableLiveAddress = async () => ({ code: '200' });
ezvizService.syncCameraStatus = async () => {};
// Recordings: a short clip about every 75 minutes in daylight (no video behind them)
ezvizService.getLocalRecords = async ({ startTime }) => {
    const day = String(startTime || '').slice(0, 10);
    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const list = [];
    for (let m = 6 * 60 + 5; m < 17 * 60 + 30; m += 75) {
        const start = new Date(`${day}T${pad(Math.floor(m / 60))}:${pad(m % 60)}:00`);
        if (start > now) break;
        const end = new Date(start.getTime() + (150 + (m % 7) * 10) * 1000);
        const fmt = (d) => `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        list.push({ startTime: fmt(start), endTime: fmt(end), recType: 'local' });
    }
    return { code: '200', data: list };
};
ezvizService.getPlaybackAddress = async () => ({ responseData: { code: '500', msg: 'Demo: no recording stream' } });

// Assistant without Vertex: picks a real tool from the question, then writes a short answer from
// its result, streamed in small pieces like the model does
const QUESTION_TOOLS = [
    [/đã thay|replaced/i, 'propose_card_change', { deviceSerial: 'BC1001' }],
    [/ảnh|photo|picture/i, 'get_recent_snapshots', { limit: 4 }],
    [/tuần|week|so sánh|compare/i, 'compare_periods', { days: 7 }],
    [/giờ|hour|24/i, 'get_insect_statistics', { mode: 'hour' }],
    [/báo cáo|report/i, 'list_reports', {}],
    [/cảnh báo|alert|tấm keo|card/i, 'get_alerts', { days: 7 }]
];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const textChunks = (text) => (async function* () {
    for (const piece of text.match(/.{1,12}(\s|$)|.{1,12}/g)) {
        await sleep(60);
        yield { candidates: [{ content: { role: 'model', parts: [{ text: piece }] } }] };
    }
})();
function demoAnswer(name, result) {
    if (result?.error) return result.error;
    if (name === 'get_recent_snapshots') return L(`Đây là ${result.totalReturned} ảnh nhận dạng mới nhất. Ảnh gần nhất có **${result.snapshots[0]?.pestsOnTrap ?? 0} con** trên bẫy.`, `Here are the ${result.totalReturned} latest photos. The newest shows **${result.snapshots[0]?.pestsOnTrap ?? 0} insects** on the trap.`);
    if (name === 'compare_periods') return L(`7 ngày qua có **${result.current.caught} con** vào bẫy, so với ${result.previous.caught ?? '--'} con tuần trước (${result.changePct > 0 ? '+' : ''}${result.changePct ?? '--'}%).`, `The last 7 days caught **${result.current.caught} insects**, against ${result.previous.caught ?? '--'} the week before (${result.changePct > 0 ? '+' : ''}${result.changePct ?? '--'}%).`);
    if (name === 'get_insect_statistics') return L(`Trong 24 giờ qua có **${round(result.records.reduce((s, r) => s + r.caught, 0))} con** vào bẫy, nhiều nhất vào buổi trưa.`, `**${round(result.records.reduce((s, r) => s + r.caught, 0))} insects** were caught over the last 24 hours, most around midday.`);
    if (name === 'list_reports') return L(`Bạn có ${result.total} báo cáo: ${result.reports.map(r => `**${r.name}**`).join(', ')}.`, `You have ${result.total} report(s): ${result.reports.map(r => `**${r.name}**`).join(', ')}.`);
    if (name === 'inspect_photo') return result.observation;
    if (name === 'propose_card_change') return L('Tôi đã chuẩn bị ghi nhận thay tấm keo. Kiểm tra thông tin rồi bấm **Xác nhận**.', 'I have prepared the card change. Check the details and press **Confirm**.');
    if (name === 'get_alerts') return L(`Có ${result.alerts.length} cảnh báo trong 7 ngày qua; ${result.cardsDue.length} tấm keo đến hạn thay.`, `${result.alerts.length} alert(s) over the last 7 days; ${result.cardsDue.length} sticky card(s) due.`);
    const worst = result.traps?.[0];
    return worst
        ? L(`Bẫy nặng nhất là **${worst.name}**: ${worst.fliesPerTrapPerDay7 ?? '--'} con/bẫy/ngày trong 7 ngày, mức ${worst.risk}.`, `The worst trap is **${worst.name}**: ${worst.fliesPerTrapPerDay7 ?? '--'} flies per trap per day over 7 days, ${worst.risk} risk.`)
        : L('Chưa có số liệu.', 'No data yet.');
}
const round = (n) => Math.round(n * 10) / 10;
// The vision model's look at a photo, without Vertex
req('src/services/aiService').describePhoto = async () => L(
    'Tấm keo có nhiều ruồi vàng, phân bố đều; vài con nằm sát nhau nên có thể đếm thiếu 1–2 con. Ảnh rõ, không bị lóa hay bẩn ống kính.',
    'The card holds many fruit flies, evenly spread; a few touch each other, so the count may be 1–2 short. The photo is sharp, with no glare or dirty lens.'
);
req('src/agent/agent').setModelClient({
    stream: async ({ contents }) => {
        const last = contents.at(-1);
        const response = last.parts?.find(p => p.functionResponse)?.functionResponse;
        if (response) {
            const suggestions = L('["📈 Tuần này so với tuần trước", "📸 Ảnh mới nhất", "🔔 Có cảnh báo gì?"]', '["📈 This week vs last week", "📸 Latest photos", "🔔 Any alerts?"]');
            return textChunks(`${demoAnswer(response.name, response.response)}\n[SUGGESTIONS]${suggestions}[/SUGGESTIONS]`);
        }
        const question = last.parts?.[0]?.text || '';
        const photo = question.match(/Selected Photo: "([a-f0-9]{24})"/);
        if (photo) {
            await sleep(300);
            return (async function* () { yield { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'inspect_photo', args: { snapshotId: photo[1] } } }] } }] }; })();
        }
        const [, name, args] = QUESTION_TOOLS.find(([re]) => re.test(question)) || [null, 'get_catch_summary', {}];
        await sleep(300);
        return (async function* () { yield { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args } }] } }] }; })();
    }
});


const HOUR_MS = 3600 * 1000;
const { app } = req('src/app');

// DEMO_LANG=en: the same farm with English names
const DEMO_LANG = process.env.DEMO_LANG === 'en' ? 'en' : 'vi';
const L = (vi, en) => (DEMO_LANG === 'en' ? en : vi);

// ---------- Showcase data: one farm in Tien Giang, 3 weeks of hourly photos ----------
const trapImage = require('./trapImage');
const imageCache = new Map();
// Photo for a snapshot key: snapshots/<serial>/<serial>_<card>_<flies>_<moths>_<ts>.jpg
function photoFor(key) {
    const m = /_(\d+)_(\d+)_(\d+)_\d+\.jpg$/.exec(key || '');
    if (!m) return trapImage.render({ seed: 1, flies: 0 }).jpeg;
    const id = `${key.split('/')[1]}:${m[1]}:${m[2]}:${m[3]}`;
    if (!imageCache.has(id)) {
        const seed = [...key.split('/')[1]].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) + Number(m[1]) * 101;
        imageCache.set(id, trapImage.render({ seed, flies: Number(m[2]), moths: Number(m[3]) }).jpeg);
    }
    return imageCache.get(id);
}
// Uploaded files other than photos (profile pictures) are kept in memory
const uploads = new Map();
s3Client.send = async (command) => {
    const { Key, Body } = command?.input || {};
    const name = command?.constructor?.name;
    if (name === 'PutObjectCommand' && String(Key).startsWith('avatars/')) { uploads.set(Key, Body); return {}; }
    if (name === 'DeleteObjectCommand') { uploads.delete(Key); return {}; }
    return { ContentType: 'image/jpeg', Body: Readable.from([uploads.get(Key) || photoFor(Key)]) };
};

const DAY = 24 * HOUR_MS;
const dayStart = (offsetDays) => { const d = new Date(Date.now() - offsetDays * DAY); d.setHours(0, 0, 0, 0); return d; };

async function seedShowcase() {
    const mk = (email, name, role, extra = {}) => models.User.create({ email, name, role, password: 'x'.repeat(60), emailVerified: true, language: DEMO_LANG, ...extra });
    const admin = await mk('admin@flybot.test', L('Quản trị FlyBot', 'FlyBot Admin'), 'admin', { createdAt: new Date('2025-01-01') });
    const manager = await mk('manager@flybot.test', L('Nguyễn Văn Minh', 'Minh Nguyen'), 'manager');
    const viewer = await mk('viewer@flybot.test', L('Trần Thị Lan', 'Lan Tran'), 'user');

    const farm = await models.Farm.create({ ownerId: manager._id, name: L('Vườn Hòa Lộc', 'Hoa Loc Orchard'), description: L('Xoài cát Hòa Lộc và bưởi da xanh, Cái Bè, Tiền Giang', 'Hoa Loc mango and green-skin pomelo, Cai Be, Tien Giang') });
    const plotDefs = [
        { name: L('Lô xoài A', 'Mango plot A'), color: '#3ecf8e', areaHa: 1.2, boundary: [[10.3402, 106.0301], [10.3406, 106.0322], [10.3389, 106.0326], [10.3385, 106.0304]] },
        { name: L('Lô bưởi B', 'Pomelo plot B'), color: '#409eff', areaHa: 0.9, boundary: [[10.3385, 106.0304], [10.3389, 106.0326], [10.3373, 106.0329], [10.3370, 106.0307]] },
        { name: L('Lô thanh long C', 'Dragon fruit plot C'), color: '#e6a23c', areaHa: 0.6, boundary: [[10.3406, 106.0322], [10.3409, 106.0338], [10.3393, 106.0341], [10.3389, 106.0326]] }
    ];
    const plots = [];
    for (const p of plotDefs) plots.push(await models.Plot.create({ farmId: farm._id, ...p }));

    // trend: daily catch multiplier by days ago (0 = today); sprayDay drops catches afterwards
    const cams = [
        { serial: 'BC1004', name: L('Bẫy thanh long C1', 'Dragon fruit trap C1'), plot: 2, lat: 10.3399, lng: 106.0331, threshold: 12, base: 1.2, offline: false, lure: true, cards: [] },
        { serial: 'BC1003', name: L('Bẫy bưởi B1', 'Pomelo trap B1'), plot: 1, lat: 10.3379, lng: 106.0316, threshold: 20, base: 2.2, cards: [20, 12] },
        { serial: 'BC1002', name: L('Bẫy xoài A2', 'Mango trap A2'), plot: 0, lat: 10.3394, lng: 106.0318, threshold: 15, base: 3, cards: [20, 13, 6] },
        { serial: 'BC1001', name: L('Bẫy xoài A1', 'Mango trap A1'), plot: 0, lat: 10.3397, lng: 106.0310, threshold: 15, base: 4.5, rising: true, cards: [20, 13, 6] }
    ];
    const CARD_DAYS = 10;
    const DAYS = 21;
    const SPRAY_DAYS_AGO = 9;

    const snaps = [];
    const events = [];
    for (const c of cams) {
        await models.Camera.create({
            userId: manager._id, deviceSerial: c.serial, deviceName: c.name, status: c.offline ? 0 : 1,
            alertThreshold: c.threshold, latitude: c.lat, longitude: c.lng, farmId: farm._id, plotId: plots[c.plot]._id,
            captureIntervalMinutes: 60, captureDaytimeOnly: true, cardReminderDays: CARD_DAYS,
            model: 'EZVIZ C3TN', deviceType: 'CS-C3TN', sharedWith: [], trapKind: c.lure ? 'lure' : 'sticky', addedAt: new Date(Date.now() - 40 * DAY),
            locationAddress: `${plotDefs[c.plot].name}, ${L('Vườn Hòa Lộc, Cái Bè', 'Hoa Loc Orchard, Cai Be')}`
        });
        const rand = (() => { let s = c.serial.charCodeAt(5) * 9301 + 49297; return () => ((s = (s * 9301 + 49297) % 233280) / 233280); })();
        let card = 0;
        let flies = 0;
        let moths = 0;
        for (let d = DAYS - 1; d >= 0; d--) {
            const day = dayStart(d);
            if (c.cards.includes(d)) {
                card++;
                flies = 0;
                moths = 0;
                events.push({ deviceSerial: c.serial, type: 'card_replaced', at: new Date(day.getTime() + 6.5 * HOUR_MS), note: L('Thay tấm bẫy vàng mới', 'New yellow sticky card'), createdBy: manager._id, createdByEmail: manager.email });
            }
            let daily = c.base * (0.75 + rand() * 0.5);
            if (d >= SPRAY_DAYS_AGO - 1 && d <= SPRAY_DAYS_AGO + 4 && c.plot === 0) daily *= 1.3;
            if (d < SPRAY_DAYS_AGO && c.plot === 0) daily *= 0.45;
            if (c.rising && d <= 3) daily = c.base * (1.6 + (3 - d) * 0.7);
            const lastHour = c.offline && d === 0 ? -1 : (d === 0 ? Math.min(18, new Date().getHours()) : 18);
            for (let h = 6; h <= lastHour; h++) {
                if (c.lure) {
                    // No glue: the flies present now, busiest late morning
                    const shape = Math.max(0, Math.sin(((h - 6) / 12) * Math.PI));
                    flies = Math.max(0, Math.round(daily * 1.6 * shape + (rand() - 0.5) * 3));
                } else {
                    const perHour = daily / 13;
                    flies += Math.floor(perHour) + (rand() < perHour - Math.floor(perHour) ? 1 : 0);
                }
                if (rand() < 0.03) moths++;
                if (c.offline && d <= 1) continue;
                const at = new Date(day.getTime() + h * HOUR_MS + 5 * 60000);
                snaps.push({ c, at, card, flies, moths });
            }
        }
    }
    // Snapshots with matching boxes
    const docs = snaps.map(({ c, at, card, flies, moths }) => {
        const key = `snapshots/${c.serial}/${c.serial}_${card}_${flies}_${moths}_${at.getTime()}.jpg`;
        const seed = [...c.serial].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) + card * 101;
        const insects = trapImageBoxes(seed, flies, moths);
        const summary = { fruit_fly: flies, ...(moths ? { moth: moths } : {}) };
        return {
            deviceSerial: c.serial, imageUrl: key, s3Key: key, createdAt: at, aiProcessed: true, aiProvider: 'roboflow',
            aiResults: { detected: flies + moths > 0, insects, summary, raw_description: `Roboflow detected ${flies} insect(s).` },
            quality: { brightness: 182, contrast: 41, sharpness: 640, clipped: 0, coverage: 0.02, issues: [], checkedAt: at }
        };
    });
    await models.Snapshot.insertMany(docs);
    await models.MaintenanceEvent.insertMany(events);
    // Draw the newest photo of each camera now, so pages do not wait for it
    for (const c of cams) photoFor(docs.filter(d => d.deviceSerial === c.serial).at(-1)?.s3Key);
    for (const c of cams) {
        const last = events.filter(e => e.deviceSerial === c.serial).at(-1) || { at: null };
        await models.Camera.updateOne({ deviceSerial: c.serial }, { $set: { cardReplacedAt: last.at, thumbnailUrl: docs.filter(d => d.deviceSerial === c.serial).at(-1)?.s3Key, imageQuality: { issues: [], checkedAt: new Date() }, lastCaptureAt: new Date(), lastSync: new Date() } });
    }
    // A few photos reviewed by the technician
    const reviewed = docs.filter((d, i) => d.deviceSerial === 'BC1001' && i % 9 === 0).slice(-6);
    for (const d of reviewed) {
        await models.Snapshot.updateOne({ s3Key: d.s3Key }, { $set: { review: { status: 'confirmed', originalSummary: d.aiResults.summary, reviewedBy: manager._id, reviewedAt: d.createdAt } } });
    }

    await models.Treatment.create({
        cameraSerials: ['BC1001', 'BC1002'], type: 'bait', at: new Date(dayStart(SPRAY_DAYS_AGO).getTime() + 7 * HOUR_MS),
        product: L('Bả protein Ento-Pro', 'Ento-Pro protein bait'), activeIngredient: L('Protein thủy phân + Abamectin', 'Hydrolyzed protein + Abamectin'), dose: L('1 lít / 20 lít nước', '1 L per 20 L water'), area: L('Lô xoài A (1,2 ha)', 'Mango plot A (1.2 ha)'),
        operator: L('Anh Tư', 'Tu'), preHarvestDays: 7, note: L('Phun điểm 1 m² mỗi cây, sáng sớm', 'Spot spray 1 m² per tree, early morning'), createdBy: manager._id, createdByEmail: manager.email
    });
    await models.Treatment.create({
        cameraSerials: ['BC1003'], type: 'sanitation', at: new Date(dayStart(5).getTime() + 8 * HOUR_MS),
        product: L('Thu gom trái rụng', 'Collect fallen fruit'), area: L('Lô bưởi B', 'Pomelo plot B'), operator: L('Chị Lan', 'Lan'), note: L('Chôn sâu 40 cm', 'Buried 40 cm deep'), createdBy: manager._id, createdByEmail: manager.email
    });

    // Organization with the technician as a member
    await req('src/services/orgService').migrateToOrganizations();
    const org = await models.Organization.findOne();
    org.name = L('HTX Trái cây Hòa Lộc', 'Hoa Loc Fruit Cooperative');
    org.members.push({ userId: viewer._id, email: viewer.email, role: 'member', addedBy: manager._id });
    await org.save();
    await req('src/services/orgService').syncOrgShares(org);

    const now = Date.now();
    await models.Notification.insertMany([
        { userId: manager._id, type: 'pest_surge', severity: 'warning', deviceSerial: 'BC1001', params: { deviceName: L('Bẫy xoài A1', 'Mango trap A1'), previous: 9, count: 24, days: 3, pct: 167 }, read: false, createdAt: new Date(now - 40 * 60000) },
        { userId: manager._id, type: 'pest_threshold', severity: 'critical', deviceSerial: 'BC1001', params: { deviceName: L('Bẫy xoài A1', 'Mango trap A1'), count: 18, threshold: 15 }, read: false, createdAt: new Date(now - 3 * HOUR_MS) },
        { userId: manager._id, type: 'camera_offline', severity: 'warning', deviceSerial: 'BC1004', params: { deviceName: L('Bẫy thanh long C1', 'Dragon fruit trap C1') }, read: false, createdAt: new Date(now - 26 * HOUR_MS) },
        { userId: manager._id, type: 'card_due', severity: 'warning', deviceSerial: 'BC1003', params: { deviceName: L('Bẫy bưởi B1', 'Pomelo trap B1'), days: 9 }, read: true, createdAt: new Date(now - 30 * HOUR_MS) }
    ]);
    // A report with every kind of widget
    const W = (id, type, w, h, extra = {}) => ({ id, type, title: '', cameraSerials: [], layout: { x: 0, y: Number(id.slice(1)), w, h }, ...extra });
    await models.Dashboard.create({
        ownerId: manager._id,
        name: L('Báo cáo mùa vụ', 'Season report'),
        description: L('Ruồi vàng trên các lô xoài, bưởi và thanh long', 'Fruit flies on the mango, pomelo and dragon fruit plots'),
        cameraSerials: ['BC1001', 'BC1002', 'BC1003', 'BC1004'],
        range: { preset: '30d' },
        visibility: 'public',
        publicToken: 'demo-season-report-link-0001',
        expiresAt: new Date(Date.now() + 60 * 24 * HOUR_MS),
        sharedWith: [{ userId: viewer._id, email: viewer.email, sharedAt: new Date() }],
        widgets: [
            W('w0', 'kpi', 24, 4), W('w1', 'trend', 16, 5), W('w2', 'species', 8, 5),
            W('w3', 'catchesByTrap', 24, 5), W('w4', 'cameraRanking', 24, 5),
            W('w5', 'dailyTable', 12, 5, { granularity: 'week' }), W('w6', 'activity', 12, 5, { range: { preset: '7d' } }),
            W('w7', 'latestSnapshot', 24, 5)
        ]
    });
    return { admin, manager, viewer };
}

function trapImageBoxes(seed, flies, moths) {
    // Same layout as the rendered photo, without drawing it
    return trapImage.render.boxes ? trapImage.render.boxes(seed, flies, moths) : boxesFromLayout(seed, flies, moths);
}
let boxesFromLayout;

(async () => {
    // Wiped on every start; FLYBOT_DEMO_DB puts it on a drive with room (MongoDB needs ~500 MB)
    const dbPath = process.env.FLYBOT_DEMO_DB || path.join(require('os').tmpdir(), 'flybot-demo-db');
    fs.rmSync(dbPath, { recursive: true, force: true });
    fs.mkdirSync(dbPath, { recursive: true });
    const mongod = await MongoMemoryServer.create({ instance: { dbPath } });
    await mongoose.connect(mongod.getUri());
    await Promise.all(Object.values(models).map(m => m.syncIndexes()));
    boxesFromLayout = trapImage.boxes;
    const users = await seedShowcase();
    await req('src/services/dailyStats').rebuildAll();
    app.listen(3013, () => {
        const tokens = {};
        for (const [k, u] of Object.entries(users)) {
            tokens[k] = {
                token: jwt.sign({ id: String(u._id), v: 0 }, env.JWT_SECRET, { expiresIn: '12h' }),
                user: { id: String(u._id), email: u.email, name: u.name, role: u.role, emailVerified: true, language: DEMO_LANG }
            };
        }
        fs.writeFileSync(path.join(__dirname, 'demo-tokens.json'), JSON.stringify(tokens, null, 2));
        console.log('Demo API on :3013');
    });
})();
