#!/usr/bin/env node
/**
 * Automated Cloud Run deploy for FlyBot (called by deploy-cloudrun.sh / deploy-cloudrun.bat).
 *
 * Every run is idempotent:
 *   1. checks gcloud, project and the local .env
 *   2. one-time setup if missing: APIs, service account + roles, Artifact Registry repo, Cloud Build roles
 *   3. creates missing Secret Manager secrets from .env (--update-secrets pushes new versions)
 *   4. fills TODO values in deploy/cloudrun.env.yaml from .env
 *   5. builds and deploys with cloudbuild.yaml, then checks /health
 *
 * Usage: node deploy/deploy-cloudrun.js [--project ID] [--region REGION] [--env-file PATH]
 *                                       [--update-secrets] [--skip-setup] [--dry-run] [--yes]
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ENV_YAML = path.join(ROOT, 'deploy', 'cloudrun.env.yaml');
const SERVICE = 'flybot';
const REPO = 'flybot';
const RUN_SA_NAME = 'flybot-run';
const IS_WINDOWS = process.platform === 'win32';

// Secret Manager name -> .env variable (must match --set-secrets in cloudbuild.yaml)
const SECRETS = {
    'flybot-jwt-secret': 'JWT_SECRET',
    'flybot-mongo-uri': 'MONGO_URI',
    'flybot-ezviz-app-key': 'APP_KEY',
    'flybot-ezviz-secret-key': 'SECRET_KEY',
    'flybot-s3-access-key': 'S3_ACCESS_KEY',
    'flybot-s3-secret-key': 'S3_SECRET_KEY',
    'flybot-roboflow-api-key': 'ROBOFLOW_API_KEY'
};

// Created and wired into Cloud Run only when the .env value is set
const OPTIONAL_SECRETS = {
    'flybot-smtp-pass': 'SMTP_PASS',
    'flybot-telegram-bot-token': 'TELEGRAM_BOT_TOKEN',
    'flybot-vapid-private-key': 'VAPID_PRIVATE_KEY',
    'flybot-roboflow-upload-key': 'ROBOFLOW_UPLOAD_API_KEY'
};

// Never copied from the local .env: these differ between development and Cloud Run
const DEPLOY_SPECIFIC_KEYS = ['NODE_ENV', 'APP_BASE_URL', 'COOKIE_SECURE', 'TRUST_PROXY', 'ENABLE_CRON', 'ALLOW_REGISTRATION'];

const APIS = [
    'run.googleapis.com',
    'cloudbuild.googleapis.com',
    'artifactregistry.googleapis.com',
    'secretmanager.googleapis.com',
    'aiplatform.googleapis.com',
    'iam.googleapis.com'
];

// ---------- CLI ----------
function parseArgs(argv) {
    const opts = { region: 'asia-southeast1', envFile: path.join(ROOT, '.env') };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) fail(`Missing value for ${arg}`);
            return argv[++i];
        };
        switch (arg) {
            case '--project': opts.project = next(); break;
            case '--region': opts.region = next(); break;
            case '--env-file': opts.envFile = path.resolve(next()); break;
            case '--update-secrets': opts.updateSecrets = true; break;
            case '--skip-setup': opts.skipSetup = true; break;
            case '--dry-run': opts.dryRun = true; break;
            case '--yes': case '-y': opts.yes = true; break;
            case '--help': case '-h': printHelp(); process.exit(0); break;
            default: fail(`Unknown option: ${arg} (see --help)`);
        }
    }
    return opts;
}

function printHelp() {
    console.log(`Deploy FlyBot to Google Cloud Run.

Options:
  --project ID        GCP project (default: gcloud config project)
  --region REGION     Cloud Run / Artifact Registry region (default: asia-southeast1)
  --env-file PATH     Local .env to read settings and secrets from (default: ./.env)
  --update-secrets    Push .env values as new secret versions (default: only create missing secrets)
  --skip-setup        Skip the one-time setup checks (APIs, service accounts, repo)
  --dry-run           Print the gcloud commands without running them
  --yes, -y           Do not ask for confirmation`);
}

// ---------- Output ----------
const color = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = color('1'), green = color('32'), yellow = color('33'), red = color('31'), dim = color('2');

function step(msg) { console.log(`\n${bold('▶ ' + msg)}`); }
function ok(msg) { console.log(`  ${green('✓')} ${msg}`); }
function warn(msg) { console.log(`  ${yellow('!')} ${msg}`); }
function fail(msg) {
    console.error(`\n${red('✗ ' + msg)}`);
    process.exit(1);
}

// ---------- gcloud runner ----------
let DRY_RUN = false;

function quoteArg(arg) {
    if (!IS_WINDOWS) return arg;
    // cmd.exe: quote anything with spaces or shell metacharacters
    return /[\s&|<>^(),;=%!"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/**
 * Run gcloud. Returns { status, stdout, stderr }.
 * mutating=true commands are only printed in --dry-run; read-only ones still run.
 */
function gcloud(args, { input, mutating = false, inherit = false, allowFail = false } = {}) {
    const printable = `gcloud ${args.join(' ')}`;
    if (DRY_RUN && mutating) {
        console.log(dim(`  [dry-run] ${printable}`));
        return { status: 0, stdout: '', stderr: '' };
    }

    const options = {
        cwd: ROOT,
        encoding: 'utf8',
        input,
        stdio: inherit ? ['inherit', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe']
    };
    const result = IS_WINDOWS
        ? spawnSync(['gcloud', ...args.map(quoteArg)].join(' '), { ...options, shell: true })
        : spawnSync('gcloud', args, options);

    if (result.error) {
        fail(`Could not run gcloud: ${result.error.message}\n  Install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install`);
    }
    const out = { status: result.status, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() };
    if (out.status !== 0 && !allowFail) {
        fail(`Command failed: ${printable}\n${out.stderr}`);
    }
    return out;
}

const exists = (args) => gcloud(args, { allowFail: true }).status === 0;

// ---------- .env ----------
function loadEnv(file) {
    if (!fs.existsSync(file)) fail(`Env file not found: ${file}`);
    const content = fs.readFileSync(file, 'utf8');
    try {
        return require(require.resolve('dotenv', { paths: [ROOT, path.join(ROOT, 'server')] })).parse(content);
    } catch {
        // Minimal fallback parser (run `npm install` to use dotenv)
        const env = {};
        for (const line of content.split(/\r?\n/)) {
            const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
            if (!m) continue;
            let value = m[2].trim();
            const quoted = value.match(/^(['"])(.*?)\1/);
            value = quoted ? quoted[2] : value.replace(/\s+#.*$/, '');
            env[m[1]] = value;
        }
        return env;
    }
}

function validateEnv(env) {
    const problems = [];
    const required = ['JWT_SECRET', 'MONGO_URI', 'APP_KEY', 'SECRET_KEY', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_ENDPOINT', 'S3_BUCKET_NAME', 'ROBOFLOW_API_KEY'];
    for (const key of required) {
        if (!env[key]) problems.push(`${key} is missing or empty`);
    }
    if (env.JWT_SECRET && env.JWT_SECRET.length < 32) problems.push('JWT_SECRET must be at least 32 characters');
    if (env.MONGO_URI && /(localhost|127\.0\.0\.1)/.test(env.MONGO_URI)) {
        problems.push('MONGO_URI points to localhost, which Cloud Run cannot reach (use MongoDB Atlas or a reachable host)');
    }
    if (env.S3_ENDPOINT && /(localhost|127\.0\.0\.1)/.test(env.S3_ENDPOINT)) {
        problems.push('S3_ENDPOINT points to localhost, which Cloud Run cannot reach');
    }
    if (problems.length) fail(`Fix these in your .env first:\n  - ${problems.join('\n  - ')}`);
}

// ---------- Steps ----------
function checkGcloud(opts) {
    step('Checking Google Cloud CLI');
    const version = gcloud(['--version']).stdout.split(/\r?\n/)[0];
    ok(version);

    const account = gcloud(['config', 'get-value', 'account'], { allowFail: true }).stdout;
    if (!account || account === '(unset)') fail('Not logged in. Run: gcloud auth login');
    ok(`Account: ${account}`);

    if (!opts.project) {
        opts.project = gcloud(['config', 'get-value', 'project'], { allowFail: true }).stdout;
    }
    if (!opts.project || opts.project === '(unset)') {
        fail('No project set. Pass --project YOUR_PROJECT_ID or run: gcloud config set project YOUR_PROJECT_ID');
    }
    if (!exists(['projects', 'describe', opts.project, '--format=value(projectId)'])) {
        fail(`Project "${opts.project}" not found or you have no access to it.`);
    }
    ok(`Project: ${opts.project}, region: ${opts.region}`);
}

function setup(opts) {
    const { project, region } = opts;
    const runSa = `${RUN_SA_NAME}@${project}.iam.gserviceaccount.com`;
    const projectNumber = gcloud(['projects', 'describe', project, '--format=value(projectNumber)']).stdout;

    step('Enabling required APIs');
    gcloud(['services', 'enable', ...APIS, `--project=${project}`], { mutating: true });
    ok(APIS.join(', '));

    step('Runtime service account');
    if (exists(['iam', 'service-accounts', 'describe', runSa, `--project=${project}`])) {
        ok(`${runSa} exists`);
    } else {
        gcloud(['iam', 'service-accounts', 'create', RUN_SA_NAME, '--display-name=FlyBot Cloud Run', `--project=${project}`], { mutating: true });
        ok(`Created ${runSa}`);
    }
    for (const role of ['roles/aiplatform.user', 'roles/secretmanager.secretAccessor']) {
        gcloud(['projects', 'add-iam-policy-binding', project, `--member=serviceAccount:${runSa}`, `--role=${role}`, '--condition=None', '--quiet'], { mutating: true });
        ok(`${role} → ${RUN_SA_NAME}`);
    }

    step('Artifact Registry repository');
    if (exists(['artifacts', 'repositories', 'describe', REPO, `--location=${region}`, `--project=${project}`])) {
        ok(`${REPO} exists in ${region}`);
    } else {
        gcloud(['artifacts', 'repositories', 'create', REPO, '--repository-format=docker', `--location=${region}`, `--project=${project}`], { mutating: true });
        ok(`Created ${REPO} in ${region}`);
    }

    step('Cloud Build permissions');
    // Newer projects build as the Compute Engine default SA; older ones as the Cloud Build SA
    let buildSa = gcloud(['builds', 'get-default-service-account', `--project=${project}`, '--format=value(serviceAccountEmail)'], { allowFail: true }).stdout;
    buildSa = (buildSa.split('/').pop() || '').trim() || `${projectNumber}@cloudbuild.gserviceaccount.com`;
    const buildMember = `serviceAccount:${buildSa}`;
    for (const role of ['roles/run.admin', 'roles/artifactregistry.writer', 'roles/logging.logWriter']) {
        gcloud(['projects', 'add-iam-policy-binding', project, `--member=${buildMember}`, `--role=${role}`, '--condition=None', '--quiet'], { mutating: true });
        ok(`${role} → ${buildSa}`);
    }
    gcloud(['iam', 'service-accounts', 'add-iam-policy-binding', runSa, `--member=${buildMember}`, '--role=roles/iam.serviceAccountUser', `--project=${project}`, '--quiet'], { mutating: true });
    ok(`roles/iam.serviceAccountUser on ${RUN_SA_NAME} → ${buildSa}`);
}

function syncSecrets(opts, env) {
    step(opts.updateSecrets ? 'Secrets (creating missing, updating existing)' : 'Secrets (creating missing)');
    const optional = Object.entries(OPTIONAL_SECRETS).filter(([, key]) => env[key]);
    for (const [name, key] of [...Object.entries(SECRETS), ...optional]) {
        const value = env[key];
        if (exists(['secrets', 'describe', name, `--project=${opts.project}`])) {
            if (opts.updateSecrets) {
                gcloud(['secrets', 'versions', 'add', name, '--data-file=-', `--project=${opts.project}`], { input: value, mutating: true });
                ok(`${name}: new version from ${key}`);
            } else {
                ok(`${name}: exists (use --update-secrets to replace with ${key})`);
            }
        } else {
            gcloud(['secrets', 'create', name, '--data-file=-', '--replication-policy=automatic', `--project=${opts.project}`], { input: value, mutating: true });
            ok(`${name}: created from ${key}`);
        }
    }
    for (const [name, key] of Object.entries(OPTIONAL_SECRETS)) {
        if (!env[key]) ok(`${name}: skipped (${key} not set in .env)`);
    }
    // Appended to --set-secrets in cloudbuild.yaml
    return optional.map(([name, key]) => `,${key}=${name}:latest`).join('');
}

function fillEnvYaml(opts, env) {
    step('Cloud Run settings (deploy/cloudrun.env.yaml)');
    const original = fs.readFileSync(ENV_YAML, 'utf8');
    const filled = [];
    const updated = original.split(/\r?\n/).map(line => {
        // Fill "TODO..." (required) and "" (optional) values from .env
        const m = line.match(/^(\s*)([A-Z_][A-Z0-9_]*):\s*"(TODO[^"]*)?"\s*$/);
        if (!m) return line;
        const key = m[2];
        if (DEPLOY_SPECIFIC_KEYS.includes(key)) return line;
        const value = key === 'VERTEX_PROJECT_ID' ? (env.VERTEX_PROJECT_ID || opts.project) : env[key];
        if (!value) return line;
        filled.push(key);
        return `${m[1]}${key}: ${JSON.stringify(value)}`;
    }).join('\n');

    if (filled.length) {
        if (DRY_RUN) {
            console.log(dim(`  [dry-run] would fill from .env: ${filled.join(', ')}`));
        } else {
            fs.writeFileSync(ENV_YAML, updated.endsWith('\n') ? updated : updated + '\n');
            ok(`Filled from .env: ${filled.join(', ')}`);
        }
    }

    const remaining = (DRY_RUN ? updated : fs.readFileSync(ENV_YAML, 'utf8')).match(/^\s*[A-Z_0-9]+:\s*"TODO/gm);
    if (remaining) fail(`deploy/cloudrun.env.yaml still has TODO values:\n  ${remaining.join('\n  ')}`);

    const cron = (updated.match(/^ENABLE_CRON:\s*"?(\w+)"?/m) || [])[1];
    ok(`ENABLE_CRON=${cron || 'true'}${cron === 'false' ? '' : ' (set "false" there if the VM runs the jobs on the same database)'}`);
}

function deploy(opts, env, extraSecrets) {
    step('Building and deploying with Cloud Build (this takes several minutes)');
    if (!env.VITE_GOOGLE_MAP_KEY) warn('VITE_GOOGLE_MAP_KEY not set in .env: the map page will have no Google Maps key');
    if (!env.SMTP_HOST) warn('SMTP_HOST not set: password reset and alert emails will not be sent');
    // "^~^" switches the separator to "~" because _EXTRA_SECRETS contains commas (gcloud topic escaping)
    const substitutions = `^~^_REGION=${opts.region}~_MAPS_KEY=${env.VITE_GOOGLE_MAP_KEY || ''}~_EXTRA_SECRETS=${extraSecrets}`;
    gcloud(['builds', 'submit', '--config=cloudbuild.yaml', `--substitutions=${substitutions}`, `--project=${opts.project}`, '.'], { mutating: true, inherit: true });
}

async function verify(opts) {
    step('Verifying');
    if (DRY_RUN) {
        console.log(dim('  [dry-run] skipped'));
        return;
    }
    const url = gcloud(['run', 'services', 'describe', SERVICE, `--region=${opts.region}`, `--project=${opts.project}`, '--format=value(status.url)']).stdout;
    ok(`Service URL: ${url}`);

    // Email links need APP_BASE_URL; default it to the Cloud Run URL and remember it for next deploys
    const yaml = fs.readFileSync(ENV_YAML, 'utf8');
    if (/^APP_BASE_URL:\s*""\s*$/m.test(yaml) && url) {
        gcloud(['run', 'services', 'update', SERVICE, `--region=${opts.region}`, `--project=${opts.project}`, `--update-env-vars=APP_BASE_URL=${url}`, '--quiet'], { mutating: true });
        fs.writeFileSync(ENV_YAML, yaml.replace(/^APP_BASE_URL:\s*""\s*$/m, `APP_BASE_URL: ${JSON.stringify(url)}`));
        ok(`APP_BASE_URL set to ${url} (saved in deploy/cloudrun.env.yaml)`);
    }
    try {
        const res = await fetch(`${url}/health`);
        const body = await res.text();
        if (res.ok) ok(`/health → ${res.status} ${body}`);
        else warn(`/health → ${res.status} ${body} (check: gcloud run services logs read ${SERVICE} --region=${opts.region})`);
    } catch (err) {
        warn(`Could not reach ${url}/health: ${err.message}`);
    }
}

function confirm(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, answer => {
        rl.close();
        resolve(/^y(es)?$/i.test(answer.trim()));
    }));
}

// ---------- Main ----------
async function main() {
    const opts = parseArgs(process.argv.slice(2));
    DRY_RUN = !!opts.dryRun;
    if (DRY_RUN) console.log(yellow('Dry run: gcloud commands that change anything are printed, not run.'));

    const env = loadEnv(opts.envFile);
    validateEnv(env);
    checkGcloud(opts);

    if (!opts.yes && !DRY_RUN) {
        const proceed = await confirm(`\nDeploy "${SERVICE}" to project ${bold(opts.project)} in ${opts.region}? [y/N] `);
        if (!proceed) fail('Cancelled.');
    }

    if (!opts.skipSetup) setup(opts);
    const extraSecrets = syncSecrets(opts, env);
    fillEnvYaml(opts, env);
    deploy(opts, env, extraSecrets);
    await verify(opts);

    console.log(`\n${green(bold('Done.'))}`);
}

main().catch(err => fail(err.stack || String(err)));
