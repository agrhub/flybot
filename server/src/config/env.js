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

// Configure Google Application Credentials for Vertex AI
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const candidateCredPaths = [
        path.resolve(process.cwd(), credPath),
        path.resolve(process.cwd(), '..', credPath),
        path.resolve(__dirname, credPath),
        path.resolve(__dirname, '..', credPath),
        path.resolve(__dirname, '../..', credPath),
        path.resolve(__dirname, '../../..', credPath)
    ];
    const foundCred = candidateCredPaths.find(p => fs.existsSync(p));
    if (foundCred) {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = foundCred;
    } else {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(credPath);
    }
} else {
    const defaultGcpPaths = [
        path.resolve(process.cwd(), 'gcp-service-account.json'),
        path.resolve(process.cwd(), '../gcp-service-account.json'),
        path.resolve(__dirname, 'gcp-service-account.json'),
        path.resolve(__dirname, '../gcp-service-account.json'),
        path.resolve(__dirname, '../../gcp-service-account.json'),
        path.resolve(__dirname, '../../../gcp-service-account.json')
    ];
    const foundDefaultGcp = defaultGcpPaths.find(p => fs.existsSync(p));
    if (foundDefaultGcp) {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = foundDefaultGcp;
    }
}

const config = {
    PORT: process.env.PORT || 3000,
    MONGO_URI: process.env.MONGO_URI || "mongodb://localhost:27017/ezviz_manager",
    // No fallback: a known default would let anyone forge login tokens
    JWT_SECRET: (process.env.JWT_SECRET || "").trim(),
    AUTH_COOKIE_NAME: 'camhub_token',
    // Set COOKIE_SECURE=true when served over HTTPS
    COOKIE_SECURE: process.env.COOKIE_SECURE === 'true',
    // Comma-separated list of extra origins allowed to call the API cross-origin (same-origin needs nothing)
    CORS_ORIGINS: (process.env.CORS_ORIGINS || "").split(',').map(o => o.trim()).filter(Boolean),
    // Express "trust proxy" setting (e.g. 1 behind one reverse proxy) so rate limits see the real client IP
    TRUST_PROXY: process.env.TRUST_PROXY || "",
    // Set ALLOW_REGISTRATION=false to close public sign-up
    ALLOW_REGISTRATION: process.env.ALLOW_REGISTRATION !== 'false',
    APP_KEY: (process.env.APP_KEY || "").trim(),
    SECRET_KEY: (process.env.SECRET_KEY || "").trim(),
    APP_DOMAIN: process.env.EZVIZ_DOMAIN || 'https://ivnopen.ezvizlife.com',
    DOMAIN_AREAS: {
        "us": "https://iusopen.ezvizlife.com",
        "sa": "https://isaopen.ezvizlife.com",
        "eu": "https://ieuopen.ezvizlife.com",
        "ru": "https://iruopen.ezvizlife.com",
        "sg": "https://isgpopen.ezvizlife.com",
        "vi": "https://ivnopen.ezvizlife.com"
    },
    RETENTION_CYCLE: parseInt(process.env.RETENTION_CYCLE || '3', 10),
    KOLOSAL_KEY: process.env.KOLOSAL_KEY || "",

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
    AI_PROVIDER: process.env.AI_PROVIDER || "vertex",

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
