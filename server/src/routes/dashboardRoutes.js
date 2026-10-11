const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');
const { authenticate, requireRole } = require('../middlewares/auth');
const { requireStringFields } = require('../middlewares/validate');
const { shareLimiter } = require('../middlewares/rateLimit');

router.use(authenticate, requireStringFields);

router.get('/', dashboardController.listDashboards);
// Viewers (role "user") only see dashboards shared with them
router.post('/', requireRole('admin', 'manager'), dashboardController.createDashboard);
router.get('/:id', dashboardController.getDashboard);
router.put('/:id', dashboardController.updateDashboard);
router.delete('/:id', dashboardController.deleteDashboard);
router.get('/:id/data', dashboardController.getDashboardData);
router.get('/:id/images/*key', dashboardController.streamDashboardImage);
router.post('/:id/public-token', dashboardController.rotatePublicToken);
router.post('/:id/share', shareLimiter, dashboardController.shareDashboard);
router.delete('/:id/share', dashboardController.unshareDashboard);

module.exports = router;
