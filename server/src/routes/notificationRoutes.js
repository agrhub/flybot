const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { rateLimit } = require('../middlewares/rateLimit');
const { authenticate } = require('../middlewares/auth');

router.use(authenticate);

router.get('/', notificationController.listNotifications);
router.post('/read', notificationController.markRead);
router.get('/stream', notificationController.stream);
router.get('/weekly-report', notificationController.weeklyReport);
// Sends email/Telegram/push: a few per hour
router.post('/weekly-report', rateLimit({ windowMs: 60 * 60 * 1000, max: 3, includeIp: false, keyFn: (req) => `report:${req.user?.id || ''}` }), notificationController.weeklyReport);

module.exports = router;
