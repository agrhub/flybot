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
const dashboardRoutes = require('./dashboardRoutes');
const publicRoutes = require('./publicRoutes');
const pushRoutes = require('./pushRoutes');
const treatmentRoutes = require('./treatmentRoutes');
const farmRoutes = require('./farmRoutes');
const orgRoutes = require('./orgRoutes');
const integrationRoutes = require('./integrationRoutes');
const publicApiRoutes = require('./publicApiRoutes');
const sentinelRoutes = require('./sentinelRoutes');
const sentinelUiRoutes = require('./sentinelUiRoutes');
const deviceRoutes = require('./deviceRoutes');
const workspaceRoutes = require('./workspaceRoutes');
const billingRoutes = require('./billingRoutes');
const paymentWebhookRoutes = require('./paymentWebhookRoutes');

// S3 image stream route must be mounted before generic /api route
router.use('/api/s3', s3Routes);
// CamOS cameras (device token, not a user session): before /api, whose sign-in would refuse them
router.use('/api/device', deviceRoutes);
// Payment providers' webhooks (signed by the provider, not a user session)
router.use('/api/payments/webhooks', paymentWebhookRoutes);
router.use('/api/auth', authRoutes);
router.use('/api/ai', aiRoutes);
router.use('/api/notifications', notificationRoutes);
router.use('/api/system', systemRoutes);
router.use('/api/telegram', telegramRoutes);
router.use('/api/admin', adminRoutes);
router.use('/api/dashboards', dashboardRoutes);
router.use('/api/push', pushRoutes);
router.use('/api/treatments', treatmentRoutes);
router.use('/api/farms', farmRoutes);
router.use('/api/orgs', orgRoutes);
router.use('/api/integrations', integrationRoutes);
router.use('/api/v1', publicApiRoutes);
// FlyBot Sentinel console for people (session sign-in; proxies the Sentinel UI API). Before
// /api/sentinel, whose HMAC check would otherwise answer these paths
router.use('/api/sentinel/ui', sentinelUiRoutes);
// FlyBot Sentinel agent (HMAC-signed, not a user session)
router.use('/api/sentinel', sentinelRoutes);
// Public (no sign-in) read-only views
router.use('/api/public', publicRoutes);
// Workspaces, plans (public list), entitlements, upgrade requests: before the camera routes,
// whose sign-in covers every other /api path
router.use('/api/billing', billingRoutes);
router.use('/api', workspaceRoutes);
router.use('/api', cameraRoutes);

module.exports = router;
