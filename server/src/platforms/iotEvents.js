const env = require('../config/env');
const aws = require('./aws');
const camos = require('./camos');

/**
 * Camera -> cloud messages from AWS IoT Core: one MQTT client over WebSocket, signed with SigV4
 * from the instance role (or the environment credentials), subscribed to the CamOS topics and
 * the lifecycle / shadow events (platforms/camos.js SUBSCRIPTIONS). Every message goes to
 * camos.handleMessage.
 *
 * Runs on the background-jobs instance only (ENABLE_CRON), like the capture cron: two
 * subscribers would handle every message twice. The IoT rule -> POST /api/device/events path
 * (routes/deviceRoutes.js) is the fallback when this client cannot stay connected.
 */
const SERVICE = 'iotdevicegateway';
// A presigned WebSocket URL is good for 5 minutes; a fresh one is kept ready for reconnects
const URL_REFRESH_MS = 4 * 60 * 1000;
const RECONNECT_MS = 5000;
// AWS IoT Core accepts at most 8 topic filters in one SUBSCRIBE and disconnects the client (CLIENT_ERROR) on more
const MAX_FILTERS_PER_SUBSCRIBE = 8;

/** The subscriptions in groups of at most MAX_FILTERS_PER_SUBSCRIBE, one SUBSCRIBE packet each. */
function subscribeBatches(topics, size = MAX_FILTERS_PER_SUBSCRIBE) {
    const out = [];
    for (let i = 0; i < topics.length; i += size) out.push(topics.slice(i, i + size));
    return out;
}

let client = null;
let refreshTimer = null;
let presigned = null;
const stats = { connected: false, messages: 0, errors: 0, lastMessageAt: null, lastError: null };

/** wss://<endpoint>/mqtt?X-Amz-... (AWS IoT "MQTT over WebSocket" with SigV4 in the query). */
async function presignUrl({ endpoint = env.IOT_ENDPOINT, region = env.AWS_REGION, credentials, now = new Date() } = {}) {
    const { SignatureV4 } = require('@smithy/signature-v4');
    const { HttpRequest } = require('@smithy/protocol-http');
    const { Sha256 } = require('@aws-crypto/sha256-js');
    const creds = credentials || await aws.credentials();
    const signer = new SignatureV4({
        service: SERVICE,
        region,
        // The session token is appended after signing, as AWS IoT expects
        credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
        sha256: Sha256,
        applyChecksum: false
    });
    const request = new HttpRequest({ protocol: 'wss:', hostname: endpoint, method: 'GET', path: '/mqtt', headers: { host: endpoint } });
    const signed = await signer.presign(request, { expiresIn: 300, signingDate: now });
    const query = Object.entries(signed.query || {}).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(Array.isArray(v) ? v[0] : v)}`);
    if (creds.sessionToken) query.push(`X-Amz-Security-Token=${encodeURIComponent(creds.sessionToken)}`);
    return `wss://${endpoint}/mqtt?${query.join('&')}`;
}

let fixedCredentials = null;
async function refreshUrl() {
    try {
        presigned = await presignUrl(fixedCredentials ? { credentials: fixedCredentials } : {});
    } catch (err) {
        stats.errors++;
        stats.lastError = err.message;
        console.error('❌ IoT WebSocket URL not signed:', err.message);
    }
}

const isEnabled = () => !!env.IOT_ENDPOINT && env.IOT_EVENTS === 'mqtt';

/** Connect and subscribe. Returns false when not configured. */
async function start({ mqttModule = null, credentials = null } = {}) {
    if (!isEnabled() || client) return false;
    fixedCredentials = credentials;
    let mqtt = mqttModule;
    if (!mqtt) {
        try {
            mqtt = require('mqtt');
        } catch {
            console.warn('⚠️ IoT events: the "mqtt" package is not installed; set IOT_EVENTS=rule or install it.');
            return false;
        }
    }
    await refreshUrl();
    if (!presigned) return false;
    refreshTimer = setInterval(refreshUrl, URL_REFRESH_MS);
    refreshTimer.unref?.();
    client = mqtt.connect(presigned, {
        clientId: `flybot-${require('os').hostname().replace(/[^A-Za-z0-9_-]/g, '')}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 64),
        protocolVersion: 4,
        clean: true,
        keepalive: 60,
        reconnectPeriod: RECONNECT_MS,
        connectTimeout: 20000,
        // Each (re)connect uses the freshest signed URL
        transformWsUrl: () => presigned
    });
    client.on('connect', () => {
        stats.connected = true;
        const batches = subscribeBatches(camos.SUBSCRIPTIONS);
        let pending = batches.length;
        let failed = false;
        for (const topics of batches) {
            client.subscribe(topics, { qos: 1 }, (err) => {
                if (err) {
                    failed = true;
                    console.error('❌ IoT subscribe failed:', err.message);
                }
                if (--pending === 0 && !failed) console.log(`📡 IoT events: subscribed to ${camos.SUBSCRIPTIONS.length} topics on ${env.IOT_ENDPOINT}`);
            });
        }
    });
    client.on('close', () => {
        // Logged, so a connection that keeps dropping shows in the server log
        if (stats.connected) console.warn('⚠️ IoT events: connection closed, reconnecting');
        stats.connected = false;
    });
    client.on('message', (topicName, payload) => {
        stats.messages++;
        stats.lastMessageAt = new Date();
        camos.handleMessage(topicName, payload).catch(err => {
            stats.errors++;
            stats.lastError = err.message;
            console.error(`⚠️ IoT message ${topicName} failed:`, err.message);
        });
    });
    client.on('error', (err) => {
        stats.errors++;
        stats.lastError = err.message;
        console.error('⚠️ IoT MQTT error:', err.message);
    });
    return true;
}

function stop() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    if (client) {
        try {
            client.end(true);
        } catch {
            // already closed
        }
    }
    client = null;
    stats.connected = false;
}

module.exports = {
    isEnabled,
    presignUrl,
    subscribeBatches,
    MAX_FILTERS_PER_SUBSCRIBE,
    start,
    stop,
    stats
};
