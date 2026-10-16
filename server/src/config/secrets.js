const { execFileSync } = require('child_process');

/**
 * Secrets from AWS Secrets Manager into the environment, before config/env.js reads it.
 *
 * FLYBOT_SECRETS: comma-separated secret names or ARNs. Each secret holds a JSON object of
 * KEY: value pairs (JWT_SECRET, APP_KEY, SECRET_KEY, SMTP_PASS, TELEGRAM_BOT_TOKEN, ...); a key
 * already set in the environment (or .env) wins. Credentials come from the default chain (the
 * EC2 instance role). Nothing is written to disk and the values are never logged.
 *
 * The fetch is synchronous on purpose (a child node process runs the SDK call) so every module
 * that reads process.env at require time sees the secrets, without a second bootstrap entry.
 */
function loadSecretsSync({ env = process.env, log = console } = {}) {
    const names = String(env.FLYBOT_SECRETS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!names.length) return { loaded: 0, keys: [] };
    const region = (env.AWS_REGION || env.AWS_DEFAULT_REGION || 'ap-southeast-2').trim();
    const script = `
        const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
        const client = new SecretsManagerClient({ region: ${JSON.stringify(region)} });
        (async () => {
            const out = {};
            for (const id of ${JSON.stringify(names)}) {
                const res = await client.send(new GetSecretValueCommand({ SecretId: id }));
                const text = res.SecretString || (res.SecretBinary ? Buffer.from(res.SecretBinary).toString('utf8') : '{}');
                let parsed;
                try { parsed = JSON.parse(text); } catch { parsed = null; }
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('secret ' + id + ' is not a JSON object');
                Object.assign(out, parsed);
            }
            process.stdout.write(JSON.stringify(out));
        })().catch(err => { process.stderr.write(err.message); process.exit(1); });
    `;
    let values;
    try {
        const stdout = execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
        values = JSON.parse(stdout);
    } catch (err) {
        const detail = String(err.stderr || err.message || '').split('\n')[0].slice(0, 200);
        log.error(`❌ Secrets Manager: could not read ${names.join(', ')}: ${detail}`);
        return { loaded: 0, keys: [], error: detail };
    }
    const keys = [];
    for (const [key, value] of Object.entries(values)) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(key) || value === null || value === undefined) continue;
        if (env[key] !== undefined && env[key] !== '') continue;
        env[key] = typeof value === 'string' ? value : JSON.stringify(value);
        keys.push(key);
    }
    log.log(`🔐 Secrets Manager: ${keys.length} value(s) loaded from ${names.join(', ')}`);
    return { loaded: keys.length, keys };
}

module.exports = { loadSecretsSync };
