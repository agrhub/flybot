/**
 * Keep tests off real services. Required first by both test harnesses:
 *  - every key from the real .env is replaced by a dummy value (dotenv never overrides
 *    variables that are already set), so no real credential is ever loaded;
 *  - axios refuses any request that is not to localhost.
 */
const fs = require('fs');
const path = require('path');

for (const file of [path.join(__dirname, '../.env'), path.join(__dirname, '../../.env')]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const key = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
        if (key && process.env[key] === undefined) process.env[key] = '';
    }
}
Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_KEY: 'test-app-key',
    SECRET_KEY: 'test-secret-key',
    S3_ACCESS_KEY: 'test',
    S3_SECRET_KEY: 'test',
    S3_ENDPOINT: 'http://127.0.0.1:9'
});
// Optional services stay off unless the test file turned them on before loading the harness
for (const key of ['ROBOFLOW_API_KEY', 'TELEGRAM_BOT_TOKEN', 'SMTP_HOST', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) {
    if (process.env[key] === undefined) process.env[key] = '';
}

const axios = require('axios');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
axios.interceptors.request.use((config) => {
    const url = new URL(config.url, config.baseURL || 'http://localhost');
    if (!LOCAL_HOSTS.has(url.hostname)) {
        throw new Error(`Test tried to call an external service: ${url.origin} (stub it)`);
    }
    return config;
});

// Vertex AI / Gemini (@google/genai) never runs in tests: the client is replaced by one whose
// every call fails, so a test that reaches the AI without stubbing it fails loudly instead of
// calling Google. Tests stub aiService / agent.setModelClient as before.
const Module = require('module');
const genaiPath = require.resolve('@google/genai');
const realGenai = require(genaiPath);
class TestGoogleGenAI {
    constructor() {
        const refuse = (name) => async () => { throw new Error(`Test tried to call Vertex AI (${name}): stub it`); };
        const surface = () => new Proxy({}, { get: (_, prop) => (prop === 'then' ? undefined : refuse(String(prop))) });
        this.models = surface();
        this.chats = surface();
        this.files = surface();
        this.caches = surface();
    }
}
const genaiModule = new Module(genaiPath);
genaiModule.filename = genaiPath;
genaiModule.loaded = true;
genaiModule.exports = { ...realGenai, GoogleGenAI: TestGoogleGenAI };
require.cache[genaiPath] = genaiModule;

// Plain fetch() (Node's undici, used by some SDKs) is held to the same rule as axios
const realFetch = globalThis.fetch;
if (typeof realFetch === 'function') {
    globalThis.fetch = (input, init) => {
        const raw = typeof input === 'string' ? input : input?.url || String(input);
        let host = '';
        try { host = new URL(raw).hostname; } catch { host = ''; }
        if (!LOCAL_HOSTS.has(host)) return Promise.reject(new Error(`Test tried to call an external service: ${raw.slice(0, 80)} (stub it)`));
        return realFetch(input, init);
    };
}
