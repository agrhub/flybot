const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startDb, stopDb, request, json } = require('./dbHelpers');
const { translateMessage } = require('../src/middlewares/localizeMessages');

before(startDb);
after(stopDb);

test('messages are translated, values kept, unknown text left alone', () => {
    assert.equal(translateMessage('Camera not found.', 'vi'), 'Không tìm thấy camera.');
    assert.equal(translateMessage('You can have at most 50 farms.', 'vi'), 'Bạn có tối đa 50 vườn.');
    assert.equal(translateMessage('Invalid count for "fruit_fly".', 'vi'), 'Số đếm của "fruit_fly" không hợp lệ.');
    assert.equal(translateMessage('Something new.', 'vi'), 'Something new.');
    assert.equal(translateMessage('Camera not found.', 'xx'), 'Camera not found.');
});

test('responses follow X-Language; no header means English', async () => {
    const body = { email: 'nobody@example.test', password: 'wrongpass1' };
    const vi = await json(await request('/api/auth/login', { method: 'POST', body, headers: { 'X-Language': 'vi' } }));
    assert.equal(vi.status, 401);
    assert.equal(vi.body.message, 'Email hoặc mật khẩu không đúng.');
    const en = await json(await request('/api/auth/login', { method: 'POST', body }));
    assert.equal(en.body.message, 'Invalid email or password.');
    const noAuth = await json(await request('/api/user/cameras', { headers: { 'X-Language': 'vi' } }));
    assert.equal(noAuth.body.message, 'Cần đăng nhập để tiếp tục.');
});

// Every message written in the server code has a Vietnamese version
test('no untranslated messages in the server code', () => {
    const files = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.js') && !full.includes(`${path.sep}agent${path.sep}`)) files.push(full);
        }
    };
    walk(path.join(__dirname, '../src'));

    const missing = [];
    const literal = /(?:message: |\{ error: |return )("([^"\n]+[.!])"|'([^'\n]+[.!])'|`([^`\n]+[.!])`)/g;
    for (const file of files) {
        const source = fs.readFileSync(file, 'utf8');
        for (const m of source.matchAll(literal)) {
            const text = (m[2] || m[3] || m[4]);
            // A value in a template: try a sample value
            const sample = text.replace(/\$\{[^}]+\}/g, '7');
            // Only sentences meant for people (start with a capital letter or a field name), not log lines
            if (!/^[A-Za-z{]/.test(sample) || /^(Roboflow|Vertex|Gemini) /.test(sample)) continue;
            if (/[📡✅⚠️❌]/u.test(sample)) continue;
            if (translateMessage(sample, 'vi') === sample) missing.push(`${path.basename(file)}: ${text}`);
        }
    }
    assert.deepEqual(missing, []);
});
