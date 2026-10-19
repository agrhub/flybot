const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authenticate, requireAdminOrSupportRead } = require('../middlewares/auth');
const { requireStringFields } = require('../middlewares/validate');

// Admins; "support" accounts may read (GET) everything here
router.use(authenticate, requireAdminOrSupportRead, requireStringFields);

router.get('/users', adminController.listUsers);
router.put('/users/:userId', adminController.updateUser);
router.delete('/users/:userId', adminController.deleteUser);
router.get('/cameras', adminController.listCameras);
router.put('/cameras/:deviceSerial/owner', adminController.transferCamera);
router.get('/settings', adminController.getSystemSettings);
router.put('/settings', adminController.updateSystemSettings);
router.get('/demo-sim', adminController.getDemoSim);
router.get('/audit', adminController.listAuditLog);
router.get('/pipeline', adminController.getPipeline);
router.get('/usage', adminController.getUsage);
router.get('/training-sync', adminController.getTrainingSync);
router.post('/training-sync/run', adminController.runTrainingSync);
router.get('/audit/export', adminController.exportAuditLog);
// Camera fleet, serial registry, firmware (controllers/fleetController.js)
const fleet = require('../controllers/fleetController');
const env = require('../config/env');
router.get('/fleet', fleet.listFleet);
router.post('/fleet/:serial/reveal-code', fleet.revealCameraCode);
router.put('/fleet/:serial/disabled', fleet.setCameraDisabled);
router.get('/registry', fleet.listRegistry);
router.post('/registry', fleet.addRegistry);
router.post('/registry/import', fleet.importRegistry);
router.post('/registry/backfill', fleet.backfillRegistry);
router.put('/registry/:serial', fleet.updateRegistry);
router.delete('/registry/:serial', fleet.deleteRegistry);
router.post('/registry/:serial/reveal-code', fleet.revealRegistryCode);
router.get('/firmware', fleet.listFirmware);
router.get('/firmware/updates', fleet.listFirmwareUpdates);
router.post('/firmware/updates/:id/cancel', fleet.cancelFirmwareUpdate);
router.post('/firmware/updates/:id/retry', fleet.retryFirmwareUpdate);
router.post('/firmware', express.raw({ type: 'multipart/form-data', limit: env.FIRMWARE_MAX_BYTES + 64 * 1024 }), fleet.addFirmware);
router.put('/firmware/:id', fleet.updateFirmware);
router.delete('/firmware/:id', fleet.deleteFirmware);
router.post('/firmware/:id/rollout', fleet.rolloutFirmware);
// Plans, workspaces and upgrade requests
const workspaceController = require('../controllers/workspaceController');
router.get('/plans', workspaceController.adminListPlans);
router.put('/plans/:code', workspaceController.adminUpdatePlan);
router.get('/workspaces', workspaceController.adminListWorkspaces);
router.post('/workspaces', workspaceController.adminCreateOrganization);
router.put('/workspaces/:id/plan', workspaceController.adminAssignPlan);
router.get('/upgrade-requests', workspaceController.adminListRequests);
router.post('/upgrade-requests/:id/approve', workspaceController.adminApprove);
router.post('/upgrade-requests/:id/reject', workspaceController.adminReject);

module.exports = router;
