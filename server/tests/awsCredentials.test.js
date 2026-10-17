const { test } = require('node:test');
const assert = require('node:assert/strict');
require('./isolation');

// SigV4 outside the SDK clients (the IoT WebSocket URL for live view) needs the default credential chain
test('aws.credentials() resolves the default credential chain', async () => {
    const saved = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY, token: process.env.AWS_SESSION_TOKEN };
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    delete process.env.AWS_SESSION_TOKEN;
    try {
        const creds = await require('../src/platforms/aws').credentials();
        assert.equal(creds.accessKeyId, 'AKIAIOSFODNN7EXAMPLE');
        assert.equal(creds.secretAccessKey, 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    } finally {
        for (const [k, v] of [['AWS_ACCESS_KEY_ID', saved.id], ['AWS_SECRET_ACCESS_KEY', saved.secret], ['AWS_SESSION_TOKEN', saved.token]]) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
});
