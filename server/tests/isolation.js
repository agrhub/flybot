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
