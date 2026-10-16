const { paymentsConfig, paymentsEnabled } = require('./config');
const { createPayosProvider } = require('./payos');
const { createStripeProvider } = require('./stripe');

/**
 * Payment providers by name. PayOS first (VietQR, Vietnam), Stripe second (international cards).
 * Built from the current settings on each call (cheap), so a settings change applies at once.
 */
function createProviders(config = paymentsConfig()) {
    return {
        payos: createPayosProvider(config.payos),
        stripe: createStripeProvider({ ...config.stripe, allowLive: config.allowLive })
    };
}

/** A provider by name, or null when unknown. */
function getProvider(name) {
    return createProviders()[String(name || '').toLowerCase()] || null;
}

/** Providers a buyer may pick (configured ones), optionally for one currency. */
function availableProviders(currency) {
    if (!paymentsEnabled()) return [];
    const wanted = currency ? String(currency).toUpperCase() : null;
    return Object.values(createProviders())
        .filter((p) => p.isConfigured() && (!wanted || p.currencies.includes(wanted)))
        .map((p) => ({ name: p.name, recurring: p.recurring, currencies: p.currencies }));
}

module.exports = { createProviders, getProvider, availableProviders };
