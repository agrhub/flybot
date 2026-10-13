const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// src/config/env loads the real .env: a test file must load a harness (dbHelpers, helpers or
// isolation, which blank every .env value) before any server code, or the real credentials
// end up in the test process. Pure constants never read the environment.
const HARNESS = /require\('\.\/(dbHelpers|helpers|isolation)'\)/;
const SERVER_CODE = /require\('\.\.\/src\/(?!constants\/)/;

test('every test file loads the harness before server code', () => {
    const wrong = [];
    for (const name of fs.readdirSync(__dirname).filter(n => n.endsWith('.test.js'))) {
        const lines = fs.readFileSync(path.join(__dirname, name), 'utf8').split('\n');
        const firstCode = lines.findIndex(l => SERVER_CODE.test(l));
        if (firstCode < 0) continue;
        const harness = lines.findIndex(l => HARNESS.test(l));
        if (harness < 0 || harness > firstCode) wrong.push(`${name}:${firstCode + 1}`);
    }
    assert.deepEqual(wrong, []);
});
