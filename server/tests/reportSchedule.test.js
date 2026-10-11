const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, sentMails, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');
const { lastSlot, sendDueReports } = require('../src/services/reportScheduleService');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const DAY = 24 * 60 * 60 * 1000;

test('the latest scheduled moment, in farm time', () => {
    // Wednesday 2026-10-14 10:00 in Vietnam (03:00 UTC)
    const wednesday = new Date('2026-10-14T03:00:00Z');
    assert.equal(lastSlot({ frequency: 'weekly', weekday: 1, hour: 7 }, wednesday).toISOString(), '2026-10-12T00:00:00.000Z', 'Monday 07:00 local');
    assert.equal(lastSlot({ frequency: 'weekly', weekday: 3, hour: 11 }, wednesday).toISOString(), '2026-10-07T04:00:00.000Z', 'not yet today: last week');
    assert.equal(lastSlot({ frequency: 'monthly', monthDay: 1, hour: 6 }, wednesday).toISOString(), '2026-09-30T23:00:00.000Z');
    assert.equal(lastSlot({ frequency: 'monthly', monthDay: 20, hour: 6 }, wednesday).toISOString(), '2026-09-19T23:00:00.000Z', 'previous month');
    assert.equal(lastSlot({ frequency: 'off' }, wednesday), null);
});

test('a scheduled report is emailed with its PDF to the owner and, if chosen, the people it is shared with', async () => {
    const owner = await createUser({ role: 'manager', language: 'en' });
    const viewer = await createUser({ role: 'user', email: 'viewer@example.test' });
    await createCamera(owner, { deviceSerial: 'A1' });
    const { body } = await json(await request('/api/dashboards', {
        method: 'POST', as: owner,
        body: { name: 'Weekly farm', cameraSerials: ['A1'], widgets: [{ id: 'k', type: 'kpi' }, { id: 't', type: 'trend' }, { id: 'r', type: 'cameraRanking' }] }
    }));
    const id = body.dashboard.id;
    await request(`/api/dashboards/${id}/share`, { method: 'POST', as: owner, body: { email: 'viewer@example.test' } });

    assert.equal((await request(`/api/dashboards/${id}`, { method: 'PUT', as: owner, body: { schedule: { frequency: 'daily' } } })).status, 400);
    assert.equal((await request(`/api/dashboards/${id}`, { method: 'PUT', as: owner, body: { schedule: { frequency: 'weekly', hour: 24 } } })).status, 400);
    const saved = await json(await request(`/api/dashboards/${id}`, {
        method: 'PUT', as: owner, body: { schedule: { frequency: 'weekly', weekday: 1, hour: 7, recipients: 'all' } }
    }));
    assert.equal(saved.body.dashboard.schedule.frequency, 'weekly');
    assert.equal(saved.body.dashboard.schedule.recipients, 'all');
    const viewerDetail = await json(await request(`/api/dashboards/${id}`, { as: viewer }));
    assert.ok(!('schedule' in viewerDetail.body.dashboard), 'only people who can edit see the schedule');

    // Saved just now: the last Monday slot is already past, so nothing goes out yet
    sentMails.length = 0;
    assert.equal(await sendDueReports(new Date()), 0);

    // A week later the next Monday has come
    const later = new Date(Date.now() + 8 * DAY);
    assert.equal(await sendDueReports(later), 2);
    const mails = sentMails.filter(m => /Weekly farm/.test(m.subject));
    assert.deepEqual(mails.map(m => m.to).sort(), [owner.email, 'viewer@example.test'].sort());
    const pdf = mails[0].attachments[0];
    assert.equal(pdf.contentType, 'application/pdf');
    assert.equal(pdf.content.subarray(0, 4).toString(), '%PDF');
    assert.match(pdf.filename, /^FlyBot_Weekly_farm_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.pdf$/);
    // Once per slot
    assert.equal(await sendDueReports(new Date(later.getTime() + 60 * 60 * 1000)), 0);
    assert.equal(await models.AuditLog.countDocuments({ action: 'dashboard.schedule_changed' }), 1);
});

test('send now: the report and its PDF to me', async () => {
    const owner = await createUser({ role: 'manager' });
    await createCamera(owner, { deviceSerial: 'A1' });
    const { body } = await json(await request('/api/dashboards', { method: 'POST', as: owner, body: { name: 'Now', cameraSerials: ['A1'], widgets: [{ id: 'k', type: 'kpi' }] } }));
    sentMails.length = 0;
    const res = await json(await request(`/api/dashboards/${body.dashboard.id}/send`, { method: 'POST', as: owner, body: { range: { preset: '30d' } } }));
    assert.equal(res.status, 200);
    assert.equal(res.body.email, owner.email);
    assert.equal(sentMails.length, 1);
    assert.equal(sentMails[0].attachments[0].content.subarray(0, 4).toString(), '%PDF');
    const stranger = await createUser({ role: 'manager' });
    assert.equal((await request(`/api/dashboards/${body.dashboard.id}/send`, { method: 'POST', as: stranger })).status, 404);
});

test('a scheduled report also goes to a linked Telegram chat, with the PDF', async () => {
    const telegramService = require('../src/services/telegramService');
    const sentDocs = [];
    const original = telegramService.queueDocument;
    telegramService.queueDocument = (chatId, doc) => sentDocs.push({ chatId, doc });
    try {
        const owner = await createUser({ role: 'manager', language: 'vi' });
        await models.User.updateOne({ _id: owner._id }, { telegram: { chatId: '4242', linkedAt: new Date() } });
        await createCamera(owner, { deviceSerial: 'A1' });
        const { body } = await json(await request('/api/dashboards', { method: 'POST', as: owner, body: { name: 'Lô xoài', cameraSerials: ['A1'], widgets: [{ id: 'k', type: 'kpi' }] } }));
        await request(`/api/dashboards/${body.dashboard.id}`, { method: 'PUT', as: owner, body: { schedule: { frequency: 'monthly', monthDay: 1, hour: 6 } } });
        sentMails.length = 0;
        assert.equal(await sendDueReports(new Date(Date.now() + 40 * DAY)), 1);
        assert.equal(sentMails.length, 1, 'email');
        assert.equal(sentDocs.length, 1, 'Telegram');
        assert.equal(sentDocs[0].chatId, '4242');
        assert.equal(sentDocs[0].doc.content.subarray(0, 4).toString(), '%PDF');
        assert.match(sentDocs[0].doc.caption, /<b>📊 Lô xoài:/);
    } finally {
        telegramService.queueDocument = original;
    }
});
