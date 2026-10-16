const express = require('express');
const { handleWebhook } = require('../services/payments/paymentService');

/**
 * POST /api/payments/webhooks/:provider (payos | stripe): no sign-in, the provider's signature
 * is the authentication. Signatures are over the exact bytes received: app.js's express.json
 * keeps req.rawBody for this path; express.raw reads any other content type.
 */
const router = express.Router();

router.post('/:provider', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const raw = req.rawBody || (Buffer.isBuffer(req.body) ? req.body : null);
    if (!raw) return res.status(400).json({ success: false, message: 'Raw body required.' });
    try {
        const outcome = await handleWebhook(req.params.provider, raw, req.headers);
        if (outcome.result === 'unknown_provider') return res.status(404).json({ success: false, message: 'Unknown payment provider.' });
        // Anything verified is acknowledged, so the provider does not retry it forever
        return res.json({ success: true, result: outcome.result });
    } catch (err) {
        if (err.name === 'WebhookSignatureError') return res.status(400).json({ success: false, message: 'Invalid signature.' });
        console.error('⚠️ Payment webhook failed:', err.message);
        // 500: the provider retries later
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

module.exports = router;
