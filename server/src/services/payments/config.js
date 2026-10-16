const env = require('../../config/env');

/**
 * Payment settings (config/env.js). Read on every call, so a test (or the admin's restart-free
 * env change) that sets env.* is seen at once.
 */
function paymentsConfig() {
    return {
        // b2b keeps manual invoicing: no checkout, webhooks are acknowledged but not applied
        appMode: env.APP_MODE,
        enabled: env.PAYMENTS_ENABLED,
        allowLive: env.PAYMENTS_ALLOW_LIVE,
        graceDays: env.PAYMENTS_GRACE_DAYS,
        payos: {
            clientId: env.PAYOS_CLIENT_ID,
            apiKey: env.PAYOS_API_KEY,
            checksumKey: env.PAYOS_CHECKSUM_KEY,
            baseUrl: env.PAYOS_API_URL,
            linkTtlMinutes: env.PAYOS_LINK_TTL_MINUTES
        },
        stripe: {
            secretKey: env.STRIPE_SECRET_KEY,
            webhookSecret: env.STRIPE_WEBHOOK_SECRET,
            baseUrl: env.STRIPE_API_URL,
            // Seconds a signed webhook stays valid (replay window)
            toleranceSeconds: env.STRIPE_WEBHOOK_TOLERANCE
        }
    };
}

/** Automatic payments run only when turned on, and never in b2b mode. */
function paymentsEnabled(config = paymentsConfig()) {
    return config.enabled && config.appMode !== 'b2b';
}

module.exports = { paymentsConfig, paymentsEnabled };
