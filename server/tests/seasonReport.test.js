const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, sentMails, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const season = require('../src/services/seasonReportService');
const { dayKeyOf, DAY_MS } = require('../src/services/dailyStats');

before(startDb);
after(stopDb);
beforeEach(() => { sentMails.length = 0; return clearDb(); });

const dayAgo = (n) => dayKeyOf(Date.now() - n * DAY_MS);

test('the period: last 6 months by default, at most a year, never in the future', () => {
    const now = new Date('2026-10-13T05:00:00Z');
    assert.deepEqual(season.parsePeriod({}, now), { fromKey: '2026-04-15', toKey: '2026-10-13', days: 182 });
    assert.deepEqual(season.parsePeriod({ from: '2026-09-01', to: '2026-09-30' }, now), { fromKey: '2026-09-01', toKey: '2026-09-30', days: 30 });
    assert.match(season.parsePeriod({ from: '2026/09/01' }, now).error, /YYYY-MM-DD/);
    assert.match(season.parsePeriod({ from: '2026-09-01', to: '2026-10-20' }, now).error, /end today/);
    assert.match(season.parsePeriod({ from: '2026-10-01', to: '2026-09-01' }, now).error, /start before/);
    assert.match(season.parsePeriod({ from: '2025-01-01', to: '2026-10-01' }, now).error, /a year/);
});

async function seed() {
    const owner = await createUser({ role: 'manager', name: 'Lan', email: 'lan@example.test' });
    const other = await createUser({ role: 'manager' });
    const mango = await models.Farm.create({ ownerId: owner._id, name: 'Mango farm' });
    const theirs = await models.Farm.create({ ownerId: other._id, name: 'Not yours' });
    const plot = await models.Plot.create({ farmId: mango._id, name: 'Plot A' });
    await createCamera(owner, { deviceSerial: 'M1', deviceName: 'Mango trap', farmId: mango._id, plotId: plot._id });
    await createCamera(other, { deviceSerial: 'X1', farmId: theirs._id });
    const docs = [];
    for (const serial of ['M1', 'X1']) {
        let count = 0;
        for (let i = 40; i >= 0; i--) {
            count += i === 20 ? 30 : 4; // one busy day 20 days ago
            docs.push({ deviceSerial: serial, day: dayAgo(i), scans: 4, total: count, peak: count, min: 0, species: [] });
        }
    }
    await models.DailyStat.insertMany(docs);
    await models.Treatment.create({ cameraSerials: ['M1'], type: 'spray', at: new Date(Date.now() - 10 * DAY_MS), product: 'Radiant 60SC', activeIngredient: 'Spinetoram', preHarvestDays: 7, operator: 'Tu' });
    await models.Treatment.create({ cameraSerials: ['X1'], type: 'spray', at: new Date(Date.now() - 10 * DAY_MS), product: 'Hidden', activeIngredient: 'Hidden' });
    return { owner, other };
}

test('the season data: the person\'s farms, months, busiest days, treatments', async () => {
    const { owner } = await seed();
    const data = await season.seasonData(owner, season.parsePeriod({ from: dayAgo(30), to: dayAgo(0) }));
    assert.deepEqual(data.farms.map(f => f.name), ['Mango farm']);
    const [farm] = data.farms;
    assert.equal(farm.traps, 1);
    assert.equal(farm.peaks[0].day, dayAgo(20));
    assert.equal(farm.peaks[0].ftd, 30);
    assert.equal(farm.worstPlot.name, 'Plot A');
    assert.ok(data.months.length >= 1);
    assert.equal(farm.treatments, 1);
    assert.deepEqual(data.treatments.map(t => t.product), ['Radiant 60SC']);
    assert.deepEqual(data.treatments[0].farms, ['Mango farm']);
    assert.deepEqual(data.ingredients.map(g => g.name), ['Spinetoram']);
});

test('the PDF downloads, and goes by email to a confirmed address', async () => {
    const { owner } = await seed();
    const res = await request(`/api/farms/season-report?from=${dayAgo(30)}&to=${dayAgo(0)}`, { as: owner });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition'), /FlyBot_season_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.pdf/);
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    assert.equal((await json(await request('/api/farms/season-report?from=bad', { as: owner }))).status, 400);

    const sent = await json(await request('/api/farms/season-report/send', { method: 'POST', as: owner, body: { from: dayAgo(30) } }));
    assert.equal(sent.status, 200);
    assert.equal(sentMails.length, 1);
    assert.equal(sentMails[0].to, 'lan@example.test');
    assert.match(sentMails[0].attachments[0].filename, /^FlyBot_season_/);

    const unconfirmed = await createUser({ role: 'manager', emailVerified: false });
    assert.equal((await request('/api/farms/season-report/send', { method: 'POST', as: unconfirmed, body: {} })).status, 400);
    assert.equal((await request('/api/farms/season-report')).status, 401);
});
