const express = require('express');
const router = express.Router();
const integrationController = require('../controllers/integrationController');
const { authenticate } = require('../middlewares/auth');
const { requireFeature } = require('../services/entitlements');
const { requireStringFields } = require('../middlewares/validate');
const { rateLimit } = require('../middlewares/rateLimit');

// API keys and webhooks: a plan feature (apiAndWebhooks) of the current workspace
router.use(authenticate, requireFeature('apiAndWebhooks'), requireStringFields);

router.get('/keys', integrationController.listKeys);
router.post('/keys', integrationController.createKey);
router.delete('/keys/:id', integrationController.revokeKey);
router.get('/webhooks', integrationController.listWebhooks);
router.post('/webhooks', integrationController.createWebhook);
router.put('/webhooks/:id', integrationController.updateWebhook);
router.delete('/webhooks/:id', integrationController.deleteWebhook);
// Calls an outside URL: a few per minute
router.post('/webhooks/:id/test', rateLimit({ windowMs: 60 * 1000, max: 5, includeIp: false, keyFn: (req) => `whtest:${req.user?.id || ''}` }), integrationController.testWebhook);

module.exports = router;
