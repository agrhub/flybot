if (!globalThis.crypto) {
    const nodeCrypto = require('crypto');
    globalThis.crypto = nodeCrypto.webcrypto || nodeCrypto;
}

const path = require('path');
const fs = require('fs');

// Search for .env file across available candidate locations (root, server/src, or server/dist)
const candidateEnvPaths = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../.env'),
    path.resolve(__dirname, '.env'),
    path.resolve(__dirname, '../.env'),
    path.resolve(__dirname, '../../.env'),
    path.resolve(__dirname, '../../../.env')
];
const foundEnv = candidateEnvPaths.find(p => fs.existsSync(p));
if (foundEnv) {
    require('dotenv').config({ path: foundEnv });
} else {
    require('dotenv').config();
}
// On AWS: secrets (JWT, EZVIZ, SMTP, Telegram...) from Secrets Manager (FLYBOT_SECRETS), filling
// in what .env and the environment did not set
if (process.env.FLYBOT_SECRETS && process.env.NODE_ENV !== 'test') require('./secrets').loadSecretsSync();

// Configure Google Application Credentials for Vertex AI
// Stray quotes around the value (e.g. ''./key.json') would otherwise become part of the path
const configuredCred = (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim().replace(/^['"]+|['"]+$/g, '');
const defaultGcpPaths = [
    path.resolve(process.cwd(), 'gcp-service-account.json'),
    path.resolve(process.cwd(), '../gcp-service-account.json'),
    path.resolve(__dirname, 'gcp-service-account.json'),
    path.resolve(__dirname, '../gcp-service-account.json'),
    path.resolve(__dirname, '../../gcp-service-account.json'),
    path.resolve(__dirname, '../../../gcp-service-account.json')
];
if (configuredCred) {
    const credPath = configuredCred;
    const candidateCredPaths = [
        path.resolve(process.cwd(), credPath),
        path.resolve(process.cwd(), '..', credPath),
        path.resolve(__dirname, credPath),
        path.resolve(__dirname, '..', credPath),
        path.resolve(__dirname, '../..', credPath),
        path.resolve(__dirname, '../../..', credPath)
    ];
    const foundCred = candidateCredPaths.find(p => fs.existsSync(p));
    const fallback = foundCred ? null : defaultGcpPaths.find(p => fs.existsSync(p));
    if (fallback) console.warn(`⚠️ GOOGLE_APPLICATION_CREDENTIALS file "${credPath}" not found; using ${fallback}`);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = foundCred || fallback || path.resolve(credPath);
} else {
    const foundDefaultGcp = defaultGcpPaths.find(p => fs.existsSync(p));
    if (foundDefaultGcp) {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = foundDefaultGcp;
    }
}

// The SMTP login, when it is an email address, doubles as sender and contact address
const SMTP_USER = (process.env.SMTP_USER || "").trim();
const SMTP_USER_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(SMTP_USER) ? SMTP_USER : "";

const config = {
    PORT: process.env.PORT || 3000,
    MONGO_URI: process.env.MONGO_URI || "mongodb://localhost:27017/ezviz_manager",
    // No fallback: a known default would let anyone forge login tokens
    JWT_SECRET: (process.env.JWT_SECRET || "").trim(),
    AUTH_COOKIE_NAME: 'flybot_token',
    // Set COOKIE_SECURE=true when served over HTTPS
    COOKIE_SECURE: process.env.COOKIE_SECURE === 'true',
    // Comma-separated list of extra origins allowed to call the API cross-origin (same-origin needs nothing)
    CORS_ORIGINS: (process.env.CORS_ORIGINS || "").split(',').map(o => o.trim()).filter(Boolean),
    // Express "trust proxy" setting (e.g. 1 behind one reverse proxy) so rate limits see the real client IP
    TRUST_PROXY: process.env.TRUST_PROXY || "",
    // Public URL of the web app, used in email links. Never derived from request headers
    // (a spoofed Host header would let attackers redirect password reset links).
    APP_BASE_URL: (process.env.APP_BASE_URL || "").replace(/\/+$/, ""),

    // Email (any SMTP provider: Google Workspace, SendGrid, Resend, Mailgun...).
    // Without SMTP_HOST, emails are only logged (development).
    SMTP_HOST: process.env.SMTP_HOST || "",
    SMTP_PORT: parseInt(process.env.SMTP_PORT || '587', 10),
    // true for port 465 (implicit TLS); false uses STARTTLS on 587
    SMTP_SECURE: process.env.SMTP_SECURE === 'true',
    SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS || "",
    // Default: the SMTP account itself (most servers refuse another sender)
    MAIL_FROM: process.env.MAIL_FROM || (SMTP_USER_EMAIL ? `FlyBot <${SMTP_USER_EMAIL}>` : "FlyBot <no-reply@localhost>"),
    // Public contact address: shown on the legal pages and receives the contact form
    // (comma-separated for several). Default: the SMTP account; without one, the form goes to the admins.
    CONTACT_EMAIL: (process.env.CONTACT_EMAIL || "").trim() || SMTP_USER_EMAIL,

    // Telegram alerts: bot token from @BotFather and the bot username (without @). Unset = feature off.
    TELEGRAM_BOT_TOKEN: (process.env.TELEGRAM_BOT_TOKEN || "").trim(),
    TELEGRAM_BOT_USERNAME: (process.env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, "").trim(),

    // Web push (installed app / browser notifications). Create the pair with
    // `node scripts/generate_vapid_keys.js`. Unset = feature off.
    VAPID_PUBLIC_KEY: (process.env.VAPID_PUBLIC_KEY || "").trim(),
    VAPID_PRIVATE_KEY: (process.env.VAPID_PRIVATE_KEY || "").trim(),
    // Contact for push services: "mailto:you@example.com" or an https URL
    VAPID_SUBJECT: (process.env.VAPID_SUBJECT || "").trim(),

    // Cameras captured and analyzed at the same time by the capture job
    CAPTURE_CONCURRENCY: Math.min(Math.max(parseInt(process.env.CAPTURE_CONCURRENCY, 10) || 4, 1), 20),
    // Set ENABLE_CRON=false on every deployment except one, so captures/cleanup don't run twice
    ENABLE_CRON: process.env.ENABLE_CRON !== 'false',
    // Set ALLOW_REGISTRATION=false to close public sign-up
    ALLOW_REGISTRATION: process.env.ALLOW_REGISTRATION !== 'false',
    APP_KEY: (process.env.APP_KEY || "").trim(),
    SECRET_KEY: (process.env.SECRET_KEY || "").trim(),
    APP_DOMAIN: process.env.EZVIZ_DOMAIN || 'https://ivnopen.ezvizlife.com',
    // "true": the browser player gets a per-user EZVIZ sub-account token limited to the cameras
    // that user may view, instead of the app account token (services/ezvizRamService.js)
    EZVIZ_RAM_TOKENS: process.env.EZVIZ_RAM_TOKENS || 'false',
    DOMAIN_AREAS: {
        "us": "https://iusopen.ezvizlife.com",
        "sa": "https://isaopen.ezvizlife.com",
        "eu": "https://ieuopen.ezvizlife.com",
        "ru": "https://iruopen.ezvizlife.com",
        "sg": "https://isgpopen.ezvizlife.com",
        "vi": "https://ivnopen.ezvizlife.com"
    },
    RETENTION_CYCLE: parseInt(process.env.RETENTION_CYCLE || '3', 10),

    // S3
    S3_BUCKET: process.env.S3_BUCKET_NAME || "ezviz-manager",
    S3_REGION: process.env.S3_REGION || "auto",
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_ACCESS_KEY: process.env.S3_ACCESS_KEY || "",
    S3_SECRET_KEY: process.env.S3_SECRET_KEY || "",
    S3_PUBLIC_URL: process.env.S3_PUBLIC_URL || "",

    // Vertex AI
    VERTEX_PROJECT_ID: process.env.VERTEX_PROJECT_ID || "gcp-project-405602",
    VERTEX_LOCATION: process.env.VERTEX_LOCATION || "us-central1",
    VERTEX_MODEL: process.env.VERTEX_MODEL || "gemini-2.5-flash",

    // Roboflow
    ROBOFLOW_API_KEY: process.env.ROBOFLOW_API_KEY || "",
    ROBOFLOW_WORKFLOW_URL: process.env.ROBOFLOW_WORKFLOW_URL || "https://serverless.roboflow.com/new-workspace-z1wc7/workflows/fruit-fly-detection-and-count-1790390843624",
    // vertex | roboflow | both | sentinel | opencv-lambda ("sentinel": no cloud model at capture;
    // FlyBot Sentinel sets the counts through POST /api/sentinel/analysis. "opencv-lambda": the
    // vision Lambda of flybot-aws is called for every photo, services/visionLambda.js)
    AI_PROVIDER: process.env.AI_PROVIDER || "vertex",

    // ---------- AWS (flybot-aws): vision Lambda, IoT Core, Kinesis Video Streams ----------
    // Credentials: the EC2 instance role, or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the
    // environment (the default AWS credential chain). Region for every AWS client here.
    AWS_REGION: (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "ap-southeast-2").trim(),
    // Vision Lambda (CONTRACTS section 1): the function name (SDK Invoke), or for local
    // development the URL of `uv run python -m sentinel.lambda_local` (http://localhost:9001/invoke).
    // The URL wins when both are set.
    VISION_LAMBDA_NAME: (process.env.VISION_LAMBDA_NAME || "").trim(),
    VISION_LAMBDA_URL: (process.env.VISION_LAMBDA_URL || "").trim(),
    // Seconds one Lambda call may take (CONTRACTS: 120)
    VISION_LAMBDA_TIMEOUT_S: Math.min(Math.max(parseInt(process.env.VISION_LAMBDA_TIMEOUT_S || '120', 10) || 120, 5), 300),
    // "true" when the photo bucket is real S3 the Lambda can read by bucket/key (the default when
    // S3_ENDPOINT is empty or an amazonaws.com endpoint); otherwise the Lambda gets a signed URL
    PHOTOS_BY_REFERENCE: process.env.PHOTOS_BY_REFERENCE !== undefined
        ? process.env.PHOTOS_BY_REFERENCE === 'true'
        : (!process.env.S3_ENDPOINT || /amazonaws\.com/i.test(process.env.S3_ENDPOINT)),
    // AWS IoT Core data endpoint of the account (aws iot describe-endpoint --endpoint-type iot:Data-ATS)
    IOT_ENDPOINT: (process.env.IOT_ENDPOINT || "").replace(/^https?:\/\//, "").trim(),
    // Device->cloud messages: "mqtt" (MQTT over WebSocket with SigV4, the default when IOT_ENDPOINT is
    // set and ENABLE_CRON is on), "rule" (an IoT rule posts them to /api/device/events) or "off"
    IOT_EVENTS: (process.env.IOT_EVENTS || "mqtt").trim(),
    // Shared secret of the IoT rule -> /api/device/events webhook (header X-IoT-Rule-Secret)
    IOT_RULE_SECRET: (process.env.IOT_RULE_SECRET || "").trim(),
    // IAM role the browser assumes (through FlyBot, STS AssumeRole, 15 min) to join a KVS signaling
    // channel as VIEWER. Empty = live view of CamOS cameras answers 503
    KVS_VIEWER_ROLE_ARN: (process.env.KVS_VIEWER_ROLE_ARN || "").trim(),
    // The cameras' own live-view keys: IoT credential provider host (describe-endpoint iot:CredentialProvider) and
    // the role alias their certificate may assume (KVS master on cam-<thing>). Both empty = cameras cannot stream
    IOT_CREDENTIALS_ENDPOINT: (process.env.IOT_CREDENTIALS_ENDPOINT || "").replace(/^https?:\/\//, "").trim(),
    IOT_ROLE_ALIAS: (process.env.IOT_ROLE_ALIAS || "").trim(),
    // Public base URL the cameras call (device API). Default: APP_BASE_URL
    DEVICE_API_BASE_URL: (process.env.DEVICE_API_BASE_URL || process.env.APP_BASE_URL || "").replace(/\/+$/, ""),
    // Firmware offered to the cameras by GET /api/device/ota (all three set = offered)
    DEVICE_OTA_FW: (process.env.DEVICE_OTA_FW || "").trim(),
    DEVICE_OTA_URL: (process.env.DEVICE_OTA_URL || "").trim(),
    DEVICE_OTA_SHA256: (process.env.DEVICE_OTA_SHA256 || "").trim().toLowerCase(),
    // How accounts and workspaces work (services/workspaceService.js):
    //   b2c    personal workspaces only, open sign-up, pricing page and upgrade requests
    //   b2b    organizations only (made by the admin), sign-up by invitation (ALLOW_SIGNUP=true opens it)
    //   hybrid both: open sign-up makes a personal workspace, organizations exist alongside (default)
    APP_MODE: ['b2c', 'b2b', 'hybrid'].includes((process.env.APP_MODE || '').trim()) ? process.env.APP_MODE.trim() : 'hybrid',
    ALLOW_SIGNUP: process.env.ALLOW_SIGNUP === 'true',
    // Delete photos older than the workspace plan's retentionDays (hourly). Off by default: the
    // admin's global retention (Settings) applies until the owner turns this on
    PLAN_RETENTION: process.env.PLAN_RETENTION === 'true',
    // Zero-touch self-registration of the public firmware (flybot-aws CONTRACTS 2a): POST /api/device/register
    // signs the camera's CSR with AWS IoT. "false" turns it off (503). Thing type and policy of the stack
    SELF_REGISTRATION: process.env.SELF_REGISTRATION !== 'false',
    IOT_THING_TYPE: (process.env.IOT_THING_TYPE || 'camos-camera').trim(),
    IOT_POLICY_NAME: (process.env.IOT_POLICY_NAME || 'camos-camera').trim(),
    // Demo limits for self-registered cameras (admins and DEMO_EXEMPT_EMAILS are exempt)
    DEMO_MAX_CAMERAS_PER_USER: Math.min(Math.max(parseInt(process.env.DEMO_MAX_CAMERAS_PER_USER || '3', 10) || 3, 0), 1000),
    DEMO_MAX_SNAPSHOTS_PER_DAY: Math.min(Math.max(parseInt(process.env.DEMO_MAX_SNAPSHOTS_PER_DAY || '48', 10) || 48, 1), 1440),
    DEMO_MAX_UNCLAIMED: Math.min(Math.max(parseInt(process.env.DEMO_MAX_UNCLAIMED || '200', 10) || 200, 0), 100000),
    DEMO_LIVE_MINUTES: Math.min(Math.max(parseInt(process.env.DEMO_LIVE_MINUTES || '5', 10) || 5, 1), 30),
    DEMO_EXEMPT_EMAILS: (process.env.DEMO_EXEMPT_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean),
    // Read-only demo cameras for visitors (services/demoView.js): the first values of the admin's
    // Settings > System > Demo access. DEMO_VIEW_CAMERAS: comma-separated serials every account
    // may view; DEMO_VIEW_SINCE: only accounts created on or after this date (empty = every
    // account); DEMO_VIEW_LIVE=true also opens live view and SD playback of those cameras
    DEMO_VIEW_ENABLED: process.env.DEMO_VIEW_ENABLED === 'true',
    DEMO_VIEW_CAMERAS: (process.env.DEMO_VIEW_CAMERAS || '').split(',').map(s => s.trim()).filter(s => /^[A-Za-z0-9_-]{1,64}$/.test(s)).slice(0, 20),
    DEMO_VIEW_SINCE: /^\d{4}-\d{2}-\d{2}/.test((process.env.DEMO_VIEW_SINCE || '').trim()) && !Number.isNaN(Date.parse(process.env.DEMO_VIEW_SINCE.trim()))
        ? new Date(process.env.DEMO_VIEW_SINCE.trim()).toISOString() : null,
    DEMO_VIEW_LIVE: process.env.DEMO_VIEW_LIVE === 'true',
    // The simulated demo farm (scripts/demo_sim.js): DEMO_VIEW_SIMULATED=true shows it to the same
    // visitors; DEMO_SIM_ENABLED=true adds each day's simulated photos until DEMO_SIM_UNTIL (YYYY-MM-DD)
    DEMO_VIEW_SIMULATED: process.env.DEMO_VIEW_SIMULATED === 'true',
    DEMO_SIM_ENABLED: process.env.DEMO_SIM_ENABLED === 'true',
    DEMO_SIM_UNTIL: /^\d{4}-\d{2}-\d{2}$/.test((process.env.DEMO_SIM_UNTIL || '').trim()) ? new Date(`${process.env.DEMO_SIM_UNTIL.trim()}T23:59:59+07:00`).toISOString() : null,
    // Registrations per client IP per hour, and in total per hour
    REGISTER_MAX_PER_IP_HOUR: Math.min(Math.max(parseInt(process.env.REGISTER_MAX_PER_IP_HOUR || '5', 10) || 5, 1), 1000),
    REGISTER_MAX_PER_HOUR: Math.min(Math.max(parseInt(process.env.REGISTER_MAX_PER_HOUR || '60', 10) || 60, 1), 100000),
    // Device clock/timezone (GET /api/device/time) when nothing better is known
    DEVICE_DEFAULT_TIMEZONE: (process.env.DEVICE_DEFAULT_TIMEZONE || 'Asia/Ho_Chi_Minh').trim(),
    // Sentinel console (menu "Sentinel", read from MongoDB): on with AI_PROVIDER=opencv-lambda,
    // or SENTINEL_CONSOLE=true on a server that keeps old traces with another provider
    SENTINEL_CONSOLE: process.env.SENTINEL_CONSOLE === 'true',

    // FlyBot Sentinel internal API (/api/sentinel, HMAC-signed). Unset = the API answers 503.
    SENTINEL_API_SECRET: (process.env.SENTINEL_API_SECRET || "").trim(),
    // Extra captures Sentinel may ask for, per camera per farm day
    SENTINEL_CAPTURE_BUDGET: /^\d+$/.test((process.env.SENTINEL_CAPTURE_BUDGET || '').trim()) ? Math.min(parseInt(process.env.SENTINEL_CAPTURE_BUDGET, 10), 96) : 4,
    // A Sentinel proposal not confirmed within this many hours expires
    SENTINEL_PROPOSAL_TTL_HOURS: Math.min(Math.max(parseInt(process.env.SENTINEL_PROPOSAL_TTL_HOURS || '24', 10) || 24, 1), 168),
    // Retraining data: reviewed snapshots are uploaded to this Roboflow project (dataset slug).
    // Needs a private API key (falls back to ROBOFLOW_API_KEY). Empty = off.
    ROBOFLOW_UPLOAD_PROJECT: process.env.ROBOFLOW_UPLOAD_PROJECT || "",
    ROBOFLOW_UPLOAD_API_KEY: process.env.ROBOFLOW_UPLOAD_API_KEY || "",
    ROBOFLOW_UPLOAD_CLASS: process.env.ROBOFLOW_UPLOAD_CLASS || "fruit_fly",

    SAMPLE_IMAGES: [
        "https://transform.roboflow.com/ldhjCjRHNERu6GtOoZyE86FWnFF2/993f0614832b88f7ef3d3523a63320f3/thumb.jpg",
        "https://transform.roboflow.com/ldhjCjRHNERu6GtOoZyE86FWnFF2/b17abe62117768fe3259aa6149a5395f/thumb.jpg",
        "https://transform.roboflow.com/ldhjCjRHNERu6GtOoZyE86FWnFF2/e99dcfc3fc78a42020378f5f2d52b6cf/thumb.jpg",
        "https://transform.roboflow.com/ldhjCjRHNERu6GtOoZyE86FWnFF2/e35839913d23f66fa9c2bc39a774bc18/thumb.jpg"
    ]
};

if (!config.JWT_SECRET || config.JWT_SECRET.length < 32) {
    console.error("❌ CONFIGURATION ERROR: JWT_SECRET must be set in your .env file (at least 32 characters).");
}

if (!config.APP_KEY || !config.SECRET_KEY) {
    console.error("❌ CONFIGURATION ERROR: Please check APP_KEY and SECRET_KEY in your .env file");
}

module.exports = config;
