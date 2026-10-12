const express = require('express');
const router = express.Router();
const camosWebhook = require('../services/camosWebhook');

// Shape of an event id (ULID or similar); anything else is not from CamOS
const EVENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * CamOS webhook: signed with the secret FlyBot registered (no sign-in). Answers 2xx once the
 * event is handled, so a failed one is delivered again (duplicates are dropped by event id).
 */
router.post('/webhook', async (req, res) => {
    const signed = camosWebhook.verifySignature({
        rawBody: req.rawBody,
        timestamp: req.get('X-CamOS-Timestamp'),
        signature: req.get('X-CamOS-Signature')
    });
    if (!signed) return res.status(401).json({ success: false, message: "Invalid signature." });
    const event = req.body;
    if (!event || typeof event.event !== 'string' || !EVENT_ID.test(String(event.id || ''))) {
        return res.status(400).json({ success: false, message: "Invalid event." });
    }
    try {
        const result = await camosWebhook.handleEvent(event);
        res.json({ success: true, result });
    } catch (err) {
        console.error(`❌ CamOS event ${event.id} (${event.event}) failed:`, err.message);
        res.status(500).json({ success: false, message: "Internal server error." });
    }
});

module.exports = router;
