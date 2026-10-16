const express = require('express');
const router = express.Router();
const sentinel = require('../controllers/sentinelController');
const { sentinelAuth } = require('../middlewares/sentinelAuth');
const { rateLimit } = require('../middlewares/rateLimit');

// FlyBot Sentinel internal API: one caller (the AWS agent), every request HMAC-signed (API.md).
// Per client IP first, so bad signatures cannot hammer the check, then for the agent overall
router.use(rateLimit({ windowMs: 60 * 1000, max: 120, keyFn: () => 'sentinel', message: 'Too many attempts. Please try again later.' }));
router.use(sentinelAuth);
router.use(rateLimit({ windowMs: 60 * 1000, max: 240, includeIp: false, keyFn: () => 'sentinel-agent', message: 'Too many attempts. Please try again later.' }));

router.post('/capture', sentinel.capture);
router.post('/capture-interval', sentinel.setCaptureInterval);
router.post('/proposals', sentinel.createProposal);
router.get('/proposals/:id', sentinel.getProposal);
router.post('/review-request', sentinel.requestReview);
router.post('/analysis', sentinel.storeAnalysis);

module.exports = router;
