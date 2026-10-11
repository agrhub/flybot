// API timings on a large generated data set (in-memory MongoDB, nothing external).
// Usage (from this folder): node benchmark.js [cameras=40] [days=180]
// Set TMP/TEMP to a drive with a few GB free: MongoDB keeps its files there while it runs.
const path = require('path');
const SERVER = path.resolve(__dirname, '../../server');
const H = require(path.join(SERVER, 'tests/dbHelpers'));
const dailyStats = require(path.join(SERVER, 'src/services/dailyStats'));
const { buildReportPdf } = require(path.join(SERVER, 'src/services/reportPdfService'));
const dashboardService = require(path.join(SERVER, 'src/services/dashboardService'));

const CAMERAS = Number(process.argv[2]) || 40;
const DAYS = Number(process.argv[3]) || 180;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const BATCH = 5000;

// A sticky card filling up and replaced every 7 days; photos every 30 minutes, 06:00 to 18:00 local
async function seed(owner) {
    const serials = [];
    for (let c = 0; c < CAMERAS; c++) {
        const serial = `P${String(c).padStart(4, '0')}`;
        serials.push(serial);
        await H.createCamera(owner, { deviceSerial: serial, deviceName: `Trap ${c + 1}`, alertThreshold: 15, status: c % 7 ? 1 : 0, trapKind: c % 5 ? 'sticky' : 'lure' });
    }
    const start = new Date(Date.now() - DAYS * DAY);
    start.setUTCHours(23, 0, 0, 0); // 06:00 local the next day
    let docs = [];
    let total = 0;
    for (const serial of serials) {
        let onCard = 0;
        for (let d = 0; d < DAYS; d++) {
            if (d % 7 === 0) onCard = 0;
            for (let slot = 0; slot < 25; slot++) {
                const createdAt = new Date(start.getTime() + d * DAY + slot * 30 * 60 * 1000);
                if (createdAt > new Date()) continue;
                onCard += Math.random() < 0.3 ? 1 : 0;
                const flies = onCard;
                const recent = Date.now() - createdAt.getTime() < 7 * DAY;
                docs.push({
                    deviceSerial: serial,
                    imageUrl: 'x',
                    s3Key: `snapshots/${serial}/${serial}_${createdAt.getTime()}.jpg`,
                    createdAt,
                    aiProcessed: true,
                    aiResults: {
                        detected: flies > 0,
                        summary: { fruit_fly: flies, moth: flies % 3 },
                        // Boxes only on the last week (the size of a real history page)
                        insects: recent ? Array.from({ length: flies }, (_, i) => ({ name: 'fruit_fly', confidence: 0.9, bbox: [i, i, i + 20, i + 20] })) : [],
                        raw_description: `Detected ${flies} insect(s).`
                    }
                });
                if (docs.length >= BATCH) {
                    await H.models.Snapshot.collection.insertMany(docs, { ordered: false });
                    total += docs.length;
                    docs = [];
                }
            }
        }
    }
    if (docs.length) {
        await H.models.Snapshot.collection.insertMany(docs, { ordered: false });
        total += docs.length;
    }
    return { serials, total };
}

async function time(label, fn, runs = 3) {
    const times = [];
    let last;
    for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        last = await fn();
        times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    console.log(`${label.padEnd(58)} ${String(Math.round(times[Math.floor(runs / 2)])).padStart(6)} ms${last?.note ? `  ${last.note}` : ''}`);
    return last;
}

(async () => {
    await H.startDb();
    try {
        const owner = await H.createUser({ role: 'manager' });
        let t0 = performance.now();
        const { serials, total } = await seed(owner);
        console.log(`Seeded ${CAMERAS} cameras, ${DAYS} days, ${total} snapshots in ${Math.round((performance.now() - t0) / 1000)} s`);
        t0 = performance.now();
        await dailyStats.rebuildAll({ log: () => {} });
        // As the startup migration does for photos stored before Snapshot.pestCount
        await require(path.join(SERVER, 'src/services/migrations')).backfillPestCounts();
        console.log(`Daily rollup rebuilt in ${Math.round((performance.now() - t0) / 1000)} s\n`);

        const get = async (url) => {
            const res = await H.request(url, { as: owner });
            const body = await res.json();
            if (res.status !== 200) throw new Error(`${url}: ${res.status} ${body.message}`);
            return body;
        };
        const since = (days) => new Date(Date.now() - days * DAY).toISOString();

        await time('overview', () => get('/api/ai/overview'));
        await time('statistics catches by day, 30 days', () => get(`/api/ai/statistics?mode=day&metric=catches&startDate=${since(30)}`));
        await time('statistics on trap by hour, 7 days', () => get(`/api/ai/statistics?mode=hour&startDate=${since(7)}`));
        await time('statistics catches by month, all', () => get(`/api/ai/statistics?mode=month&metric=catches&startDate=${since(DAYS)}`));
        await time('insights, 30 days', () => get('/api/ai/insights?days=30'));
        await time('comparison, 30 days', () => get('/api/ai/comparison?days=30'));
        await time('history page 1 (10), all cameras, 90 days', () => get(`/api/ai/results?limit=10&startDate=${since(90)}`));
        await time('history page 1 (10), risk=high, 90 days', () => get(`/api/ai/results?limit=10&risk=high&startDate=${since(90)}`));
        await time('history page 1 (10), risk=high, all time', () => get(`/api/ai/results?limit=10&risk=high`));
        await time('history export 500/page, one camera, 30 days', async () => {
            let page = 1;
            let rows = 0;
            for (;;) {
                const body = await get(`/api/ai/results?limit=500&page=${page}&deviceSerials=${serials[0]}&startDate=${since(30)}`);
                rows += body.results.length;
                if (rows >= body.total || !body.results.length) return { note: `${rows} rows, ${page} pages` };
                page++;
            }
        }, 1);

        const widgets = ['kpi', 'trend', 'catchesByTrap', 'species', 'cameraRanking', 'dailyTable', 'activity', 'latestSnapshot']
            .map((type, i) => ({ id: `w${i}`, type, layout: { x: 0, y: i, w: 24, h: 5 } }));
        const created = await (await H.request('/api/dashboards', { method: 'POST', as: owner, body: { name: 'Perf', cameraSerials: serials.slice(0, 50), widgets, visibility: 'public' } })).json();
        const id = created.dashboard.id;
        for (const preset of ['7d', '30d', '3m', '6m', '12m']) {
            await time(`report data, all widgets, ${preset}`, () => get(`/api/dashboards/${id}/data?range=${preset}`));
        }
        await time('public report, 3 months (cached after the first)', async () => (await H.request(`/api/public/dashboards/${created.dashboard.publicToken}?range=3m`)).json());

        const dashboard = await H.models.Dashboard.findById(id);
        await time('report PDF on the server, 3 months', async () => {
            const { range, widgets: data } = await dashboardService.computeWidgetData(dashboard, serials.slice(0, 50), { imageUrl: () => '', range: { preset: '3m' } });
            const pdf = buildReportPdf({ dashboard, data, range, language: 'vi' });
            return { note: `${Math.round(pdf.length / 1024)} KB` };
        });
    } finally {
        await H.stopDb();
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
