const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { models, startDb, stopDb, clearDb, request, createUser, createCamera, json } = require('./dbHelpers');

before(startDb);
after(stopDb);
beforeEach(clearDb);

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

async function seed() {
    const me = await createUser({ role: 'manager' });
    const other = await createUser({ role: 'manager' });
    await createCamera(me, { deviceSerial: 'M1' });
    await createCamera(me, { deviceSerial: 'M2' });
    await createCamera(other, { deviceSerial: 'X1' });
    // Already in the log
    await models.Treatment.create({ cameraSerials: ['M1'], type: 'spray', at: new Date(daysAgo(10)), product: 'Radiant 60SC', createdBy: me._id });
    return { me };
}

const ROWS = [
    { type: 'spray', at: daysAgo(3), cameraSerials: ['M1', 'M2'], product: 'Radiant 60SC', activeIngredient: 'Spinetoram', preHarvestDays: 7 },
    { type: 'bait', at: daysAgo(2), cameraSerials: ['M2'], product: 'Methyl eugenol' },
    { type: 'spray', at: daysAgo(10), cameraSerials: ['M1'], product: 'radiant 60sc' },        // already logged
    { type: 'spray', at: daysAgo(3), cameraSerials: ['M2', 'M1'], product: 'Radiant 60SC' },  // twice in the file
    { type: 'spray', at: daysAgo(1), cameraSerials: ['X1'], product: 'Abc' },                 // not my camera
    { type: 'spray', at: daysAgo(1), cameraSerials: ['M1'] },                                 // no product
    { type: 'flood', at: daysAgo(1), cameraSerials: ['M1'] },
    { type: 'spray', at: 'last week', cameraSerials: ['M1'], product: 'Abc' },
    { type: 'spray', at: daysAgo(1), cameraSerials: ['M1'], product: 'Abc', note: 'x'.repeat(501) },
    'not a row'
];

test('import: a preview first (nothing saved), then the same rows saved, one status per row', async () => {
    const { me } = await seed();
    const preview = await json(await request('/api/treatments/import', { method: 'POST', as: me, body: { rows: ROWS, dryRun: true } }));
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.results.map(r => r.status + (r.code ? `:${r.code}` : '')), [
        'ready', 'ready', 'duplicate', 'duplicate',
        'error:CAMERA_NOT_FOUND', 'error:PRODUCT_REQUIRED', 'error:INVALID_TYPE', 'error:INVALID_DATE', 'error:TEXT_TOO_LONG', 'error:INVALID_ROW'
    ]);
    assert.equal(preview.body.results[8].field, 'note');
    assert.deepEqual(preview.body.summary, { rows: 10, ready: 2, imported: 0, duplicate: 2, error: 6 });
    assert.equal(await models.Treatment.countDocuments(), 1, 'a preview saves nothing');

    const done = await json(await request('/api/treatments/import', { method: 'POST', as: me, body: { rows: ROWS } }));
    assert.equal(done.body.summary.imported, 2);
    const saved = await models.Treatment.find().sort({ at: 1 }).lean();
    assert.equal(saved.length, 3);
    assert.deepEqual(saved[1].cameraSerials, ['M1', 'M2']);
    assert.equal(saved[1].preHarvestDays, 7);
    assert.equal(String(saved[1].createdBy), String(me._id));

    // The same file again: everything is already there
    const again = await json(await request('/api/treatments/import', { method: 'POST', as: me, body: { rows: ROWS.slice(0, 2) } }));
    assert.deepEqual(again.body.summary, { rows: 2, ready: 0, imported: 0, duplicate: 2, error: 0 });

    const audit = await models.AuditLog.findOne({ action: 'treatment.imported' }).lean();
    assert.equal(audit.details.count, 2);
});

test('import: rows are required, 500 at most, signed in only', async () => {
    const { me } = await seed();
    assert.equal((await request('/api/treatments/import', { method: 'POST', as: me, body: { rows: [] } })).status, 400);
    const many = Array.from({ length: 501 }, () => ROWS[0]);
    const tooMany = await json(await request('/api/treatments/import', { method: 'POST', as: me, body: { rows: many, dryRun: true } }));
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body.message, /500/);
    assert.equal((await request('/api/treatments/import', { method: 'POST', body: { rows: ROWS } })).status, 401);
});

test('import: a camera shared for viewing only cannot be written to', async () => {
    const owner = await createUser({ role: 'manager' });
    const viewer = await createUser();
    await createCamera(owner, { deviceSerial: 'SH1', sharedWith: [{ userId: viewer._id, email: viewer.email, status: 'active' }] });
    const res = await json(await request('/api/treatments/import', { method: 'POST', as: viewer, body: { rows: [{ type: 'spray', at: daysAgo(1), cameraSerials: ['SH1'], product: 'Abc' }] } }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.results, [{ row: 0, status: 'error', code: 'CAMERA_NOT_FOUND' }]);
    assert.equal(await models.Treatment.countDocuments(), 0);
});
