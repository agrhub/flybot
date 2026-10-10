const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authenticate, requireRole } = require('../middlewares/auth');
const { requireStringFields } = require('../middlewares/validate');

// Everything here is admin-only
router.use(authenticate, requireRole('admin'), requireStringFields);

router.get('/users', adminController.listUsers);
router.put('/users/:userId', adminController.updateUser);
router.delete('/users/:userId', adminController.deleteUser);
router.get('/cameras', adminController.listCameras);
router.put('/cameras/:deviceSerial/owner', adminController.transferCamera);
router.get('/settings', adminController.getSystemSettings);
router.put('/settings', adminController.updateSystemSettings);
router.get('/audit', adminController.listAuditLog);
router.get('/training-sync', adminController.getTrainingSync);
router.post('/training-sync/run', adminController.runTrainingSync);
router.get('/audit/export', adminController.exportAuditLog);

module.exports = router;
