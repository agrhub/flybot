const express = require('express');
const router = express.Router();
const api = require('../controllers/publicApiController');
const { rateLimit } = require('../middlewares/rateLimit');

// Public read-only API, authenticated with an API key (see API.md)
// Per client IP first, so bad keys cannot hammer the key lookup
router.use(rateLimit({ windowMs: 60 * 1000, max: 300, keyFn: () => 'apiv1', message: 'Too many attempts. Please try again later.' }));
router.use(api.authenticateApiKey);
router.use(rateLimit({ windowMs: 60 * 1000, max: 120, includeIp: false, keyFn: (req) => `apikey:${req.apiKeyId}`, message: 'Rate limit: 120 requests per minute per key.' }));

router.get('/me', api.me);
router.get('/cameras', api.listCameras);
router.get('/cameras/:serial', api.getCamera);
router.get('/cameras/:serial/daily', api.dailyCounts);
router.get('/cameras/:serial/snapshots', api.snapshots);
router.get('/alerts', api.alerts);

module.exports = router;
