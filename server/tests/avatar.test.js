const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jpeg = require('jpeg-js');
const { models, startDb, stopDb, clearDb, request, createUser, json } = require('./dbHelpers');
const s3Service = require('../src/services/s3Service');
const avatarService = require('../src/services/avatarService');

before(startDb);
after(stopDb);
beforeEach(clearDb);

// What reaches "S3" in this test
const stored = new Map();
s3Service.uploadSnapshot = async (key, buffer) => { stored.set(key, buffer); };
s3Service.deleteS3Object = async (key) => { stored.delete(key); };

function image(width, height) {
    const data = Buffer.alloc(width * height * 4, 200);
    return Buffer.from(jpeg.encode({ data, width, height }, 90).data);
}
const upload = (user, body, type = 'image/jpeg') => request('/api/auth/avatar', { method: 'POST', as: user, body, headers: { 'Content-Type': type } });

test('upload, replace and remove an avatar', async () => {
    stored.clear();
    const user = await createUser();
    const first = await json(await upload(user, image(256, 256)));
    assert.equal(first.status, 200);
    assert.match(first.body.user.avatar, /^\/api\/auth\/avatar\?v=[a-f0-9]{16}$/);
    assert.equal(stored.size, 1);
    const [firstKey] = stored.keys();
    assert.ok(firstKey.startsWith(`avatars/${user._id}/`));
    // What is stored is a clean JPEG of the same size
    const decoded = jpeg.decode(stored.get(firstKey));
    assert.deepEqual([decoded.width, decoded.height], [256, 256]);

    assert.equal((await request(first.body.user.avatar, { as: user })).status, 200);
    assert.equal((await request('/api/auth/avatar')).status, 401);

    const second = await json(await upload(user, image(128, 128)));
    assert.notEqual(second.body.user.avatar, first.body.user.avatar);
    assert.equal(stored.size, 1, 'the previous file is removed');
    assert.ok(!stored.has(firstKey));

    const removed = await json(await request('/api/auth/avatar', { method: 'DELETE', as: user }));
    assert.equal(removed.body.user.avatar, '');
    assert.equal(stored.size, 0);
    assert.equal((await request('/api/auth/avatar', { as: user })).status, 404);
});

test('bad uploads are refused', async () => {
    const user = await createUser();
    const notImage = await json(await upload(user, Buffer.from('not an image at all')));
    assert.equal(notImage.status, 400);
    const truncated = await json(await upload(user, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100)])));
    assert.equal(truncated.status, 400);
    const huge = await json(await upload(user, image(1600, 1200)));
    assert.equal(huge.status, 400);
    const tooBig = await json(await upload(user, Buffer.alloc(avatarService.AVATAR_MAX_BYTES + 10, 1)));
    assert.equal(tooBig.status, 400);
    assert.match(tooBig.body.message, /2 MB/);
    assert.equal((await request('/api/auth/avatar', { method: 'POST', as: user, body: { avatar: 'x' } })).status, 400);
});

test('the profile form cannot point the avatar elsewhere', async () => {
    const user = await createUser();
    await request('/api/auth/profile', { method: 'POST', as: user, body: { avatar: `avatars/${user._id}/0123456789abcdef.jpg` } });
    assert.equal((await models.User.findById(user._id).lean()).avatar, '');
    // An older free-text value is not served as a file
    await models.User.updateOne({ _id: user._id }, { avatar: 'https://example.test/me.png' });
    const me = await json(await request('/api/auth/me', { as: user }));
    assert.equal(me.body.user.avatar, '');
});
