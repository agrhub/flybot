const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
// The harness first: it replaces every .env value before anything reads them
const { sentMails, startDb, stopDb, clearDb, request, json } = require('./dbHelpers');
const env = require('../src/config/env');
const { TOKEN, ROW_IDS } = require('../src/config/expertReview');

before(startDb);
after(stopDb);
beforeEach(async () => {
    await clearDb();
    env.CONTACT_EMAIL = 'hello@flybot.example';
});

const url = (token = TOKEN) => `/api/public/expert-review/${token}`;
const save = (body, token) => request(url(token), { method: 'POST', body });

test('the review page saves answers without an account and reads them back', async () => {
    assert.equal(ROW_IDS.length, 50);
    const empty = await json(await request(url()));
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.answers, []);

    const res = await json(await save({ answers: [
        { id: 'AWS-01', verdict: 'correct', note: '', t: 10 },
        { id: 'FIJ-07', verdict: 'incorrect', note: 'Lẽ ra nên báo người: tay che bẫy', t: 11 }
    ] }));
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 50);
    assert.equal(res.body.emailed, false);
    assert.deepEqual(res.body.answers.map(a => a.id), ['AWS-01', 'FIJ-07']);

    const back = await json(await request(url()));
    assert.equal(back.body.answers[1].note, 'Lẽ ra nên báo người: tay che bẫy');
    assert.equal(sentMails.length, 0, 'saving alone sends no email');
});

test('the answer changed last wins, so an old tab cannot undo a newer one', async () => {
    await save({ answers: [{ id: 'RPL-03', verdict: 'unsure', note: 'mờ', t: 200 }] });
    await save({ answers: [{ id: 'RPL-03', verdict: 'correct', note: '', t: 100 }, { id: 'STG-01', verdict: 'correct', t: 150 }] });
    const { body } = await json(await request(url()));
    assert.deepEqual(body.answers.map(a => [a.id, a.verdict]), [['RPL-03', 'unsure'], ['STG-01', 'correct']]);
});

test('send emails every answer to the operator', async () => {
    const res = await json(await save({ send: true, answers: [
        { id: 'AWS-02', verdict: 'correct', t: 1 },
        { id: 'AWS-03', verdict: 'incorrect', note: 'Ảnh rõ, không cần chụp lại', t: 2 }
    ] }));
    assert.equal(res.status, 200);
    assert.equal(res.body.emailed, true);
    assert.ok(res.body.sentAt);
    const mail = sentMails.at(-1);
    assert.equal(mail.to, 'hello@flybot.example');
    assert.match(mail.subject, /2\/50/);
    assert.match(mail.text, /AWS-03 \| incorrect \| Ảnh rõ, không cần chụp lại/);
});

test('a wrong token or bad answers are refused', async () => {
    assert.equal((await request(url('not-the-token'))).status, 404);
    assert.equal((await save({ answers: [{ id: 'AWS-01', verdict: 'correct' }] }, 'not-the-token')).status, 404);
    for (const answers of [
        'AWS-01 correct',
        [{ id: 'EX-1', verdict: 'correct' }],
        [{ id: 'AWS-01', verdict: 'maybe' }],
        [{ id: 'AWS-01', verdict: 'correct' }, { id: 'AWS-01', verdict: 'unsure' }],
        [{ id: 'AWS-01', verdict: 'incorrect', note: 'x'.repeat(1001) }]
    ]) {
        const res = await json(await save({ answers }));
        assert.equal(res.status, 400, JSON.stringify(answers).slice(0, 60));
        assert.equal(res.body.message, 'The answers are not valid.');
    }
    const vi = await json(await request(url('nope'), { headers: { 'X-Language': 'vi' } }));
    assert.equal(vi.body.message, 'Không tìm thấy bảng đánh giá.');
});
