const express = require('express');
const router = express.Router();
const telegramController = require('../controllers/telegramController');
const { authenticate } = require('../middlewares/auth');
const { rateLimit } = require('../middlewares/rateLimit');

// Each call sends a Telegram message or creates a link code
const telegramLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, includeIp: false, keyFn: (req) => req.user?.id || '' });

router.use(authenticate);
router.post('/link', telegramLimiter, telegramController.createLink);
router.delete('/link', telegramController.unlink);
router.post('/test', telegramLimiter, telegramController.sendTest);

module.exports = router;
