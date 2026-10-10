const express = require('express');
const router = express.Router();

const authRoutes = require('./authRoutes');
const cameraRoutes = require('./cameraRoutes');
const aiRoutes = require('./aiRoutes');
const s3Routes = require('./s3Routes');
const notificationRoutes = require('./notificationRoutes');
const systemRoutes = require('./systemRoutes');
const telegramRoutes = require('./telegramRoutes');
const adminRoutes = require('./adminRoutes');

// S3 image stream route must be mounted before generic /api route
router.use('/api/s3', s3Routes);
router.use('/api/auth', authRoutes);
router.use('/api/ai', aiRoutes);
router.use('/api/notifications', notificationRoutes);
router.use('/api/system', systemRoutes);
router.use('/api/telegram', telegramRoutes);
router.use('/api/admin', adminRoutes);
router.use('/api', cameraRoutes);

module.exports = router;
