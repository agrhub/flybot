const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { authenticate } = require('../middlewares/auth');

router.use(authenticate);

router.get('/', notificationController.listNotifications);
router.post('/read', notificationController.markRead);
router.get('/stream', notificationController.stream);

module.exports = router;
