const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, sentMails, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const vietgap = require('../src/services/vietgapService');

before(startDb);
after(stopDb);
beforeEach(() => { sentMails.length = 0; return clearDb(); });

// 07:00 on 1 October 2026, farm time (UTC+7)
const NOW = new Date('2026-10-01T00:00:00Z');
const treatment = (serials, at, extra = {}) => models.Treatment.create({ cameraSerials: serials, type: 'spray', at: new Date(at), product: 'Abamectin', ...extra });

test('the previous month in farm time', () => {
    const sep = vietgap.previousMonth(NOW);
    assert.equal(sep.label, '09/2026');
    assert.equal(sep.from.toISOString(), '2026-08-31T17:00:00.000Z');
    assert.equal(sep.to.toISOString(), '2026-09-30T16:59:59.999Z');
    // Just after midnight on 1 January, farm time: December of the year before
    assert.equal(vietgap.previousMonth(new Date('2025-12-31T17:30:00Z')).label, '12/2025');
});

test('a person gets last month\'s treatments on the traps they can see, as a PDF', async () => {
    const owner = await createUser({ role: 'manager', name: 'Lan' });
    const other = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'MINE', deviceName: 'Mango trap A1' });
    await createCamera(other, { deviceSerial: 'THEIRS' });
    await treatment(['MINE'], '2026-09-03T02:00:00Z', { preHarvestDays: 7, operator: 'Tuan' });
    await treatment(['MINE'], '2026-08-31T17:30:00Z'); // 1 September 00:30 farm time: counts
    await treatment(['THEIRS'], '2026-09-10T02:00:00Z'); // not theirs to see
    await treatment(['MINE'], '2026-10-01T01:00:00Z'); // this month

    const result = await vietgap.sendVietGapLog(owner, { now: NOW });
    assert.deepEqual([result.sent, result.count, result.month], [true, 2, '09/2026']);
    assert.equal(sentMails.length, 1);
    const mail = sentMails[0];
    assert.equal(mail.to, owner.email);
    assert.match(mail.subject, /09\/2026/);
    assert.equal(mail.attachments[0].filename, 'FlyBot_VietGAP_2026-09.pdf');
    assert.equal(Buffer.from(mail.attachments[0].content).subarray(0, 4).toString(), '%PDF');

    const rows = await vietgap.monthlyRecord(owner, vietgap.previousMonth(NOW));
    assert.deepEqual(rows.map(r => r.traps), [['Mango trap A1'], ['Mango trap A1']]);
});

test('nothing is sent for a month without treatments, and only to those who turned it on', async () => {
    const quiet = await createUser({ role: 'manager', notificationPrefs: { vietgapMonthly: true } });
    await createCamera(quiet, { deviceSerial: 'Q1' });
    const busy = await createUser({ role: 'manager', notificationPrefs: { vietgapMonthly: true } });
    await createCamera(busy, { deviceSerial: 'B1' });
    const off = await createUser({ role: 'manager' });
    await createCamera(off, { deviceSerial: 'O1' });
    await treatment(['B1'], '2026-09-15T02:00:00Z');
    await treatment(['O1'], '2026-09-15T02:00:00Z');

    assert.equal((await vietgap.sendVietGapLog(quiet, { now: NOW })).reason, 'empty');
    assert.equal(sentMails.length, 0);
    const { sent } = await vietgap.sendMonthlyVietGapLogs(NOW);
    assert.equal(sent, 1);
    assert.deepEqual(sentMails.map(m => m.to), [busy.email]);
});

test('the setting and the "send me now" request', async () => {
    const user = await createUser({ role: 'manager' });
    await createCamera(user, { deviceSerial: 'S1' });
    const saved = await json(await request('/api/auth/profile', { method: 'POST', as: user, body: { notificationPrefs: { vietgapMonthly: true } } }));
    assert.equal(saved.body.user.notificationPrefs.vietgapMonthly, true);

    // Last month relative to today: put a treatment in it
    const month = vietgap.previousMonth(new Date());
    await treatment(['S1'], new Date(month.from.getTime() + 36e5));
    const sent = await json(await request('/api/treatments/vietgap/send', { method: 'POST', as: user }));
    assert.deepEqual([sent.status, sent.body.sent, sent.body.count], [200, true, 1]);

    const unconfirmed = await createUser({ role: 'manager', emailVerified: false });
    const refused = await json(await request('/api/treatments/vietgap/send', { method: 'POST', as: unconfirmed }));
    assert.equal(refused.body.code, 'NO_CHANNEL');
});
