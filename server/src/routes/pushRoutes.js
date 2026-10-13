const express = require('express');
const router = express.Router();
const pushController = require('../controllers/pushController');
const { authenticate } = require('../middlewares/auth');
const { rateLimit } = require('../middlewares/rateLimit');

// Test pushes go out to every device of the account: a few per minute is plenty
const testLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, includeIp: false, keyFn: (req) => req.user?.id || '' });

router.use(authenticate);
router.get('/config', pushController.getConfig);
router.post('/subscriptions', pushController.subscribe);
router.delete('/subscriptions', pushController.unsubscribe);
router.post('/test', testLimiter, pushController.sendTest);

module.exports = router;
