const express = require('express');
const router = express.Router();
const cameraController = require('../controllers/cameraController');
const shareController = require('../controllers/shareController');
const maintenanceController = require('../controllers/maintenanceController');
const { authenticate } = require('../middlewares/auth');
const { requireCameraSlot } = require('../services/entitlements');
const { requireStringFields } = require('../middlewares/validate');
// Manual captures share their quota with the AI assistant's capture tool
const { captureLimiter, shareLimiter, rateLimit } = require('../middlewares/rateLimit');

// Apply authentication to all camera routes
router.use(authenticate);
router.use(requireStringFields);

// User camera management
router.get('/user/cameras', cameraController.getUserCameras);
// Owner or manager of the current workspace, within its plan's camera limit (403 UPGRADE_REQUIRED);
// edit/delete/share check ownership per camera
router.post('/user/add-camera', requireCameraSlot, cameraController.addCamera);
router.put('/user/camera', cameraController.updateCamera);
router.post('/user/update-camera', cameraController.updateCamera);
router.put('/user/camera/location', cameraController.updateCameraLocation);
router.post('/user/update-camera-location', cameraController.updateCameraLocation);
router.delete('/user/delete-camera', cameraController.deleteCamera);
router.post('/user/update-camera-code', cameraController.updateCameraCode);
router.get('/user/cameras/health', cameraController.getCamerasHealth);
router.get('/user/cameras/threshold-suggestions', cameraController.getThresholdSuggestions);
router.get('/user/camera/shares', shareController.listShares);
router.post('/user/camera/share', shareLimiter, shareController.addShare);
router.delete('/user/camera/share', shareController.removeShare);
router.post('/user/share/remind', shareLimiter, shareController.remindInvitee);
router.post('/user/camera/capture', captureLimiter, cameraController.captureNow);
// CamOS cameras: a new provisioning token for the camera's portal
router.post('/user/camera/provision', cameraController.provisionCamera);
router.get('/user/camera/maintenance', maintenanceController.listEvents);
router.post('/user/camera/maintenance', maintenanceController.addEvent);
router.delete('/user/camera/maintenance/:id', maintenanceController.deleteEvent);

// Self-registered CamOS cameras: claim one (any signed-in account; 20 tries a minute per person)
router.post('/cameras/claim', rateLimit({ windowMs: 60 * 1000, max: 20, keyFn: (req) => String(req.user?.id || ''), message: 'Too many attempts.' }), cameraController.claimCamera);

// Platform-aware camera endpoints (EZVIZ, CamOS over IoT Core, KVS live view)
router.get('/cameras/:serial/live', cameraController.getLive);
router.post('/cameras/:serial/live/request', cameraController.requestLive);
router.get('/cameras/:serial/playback', cameraController.getPlayback);
router.get('/cameras/:serial/status', cameraController.getCameraStatus);
// camos-esp32-trap cameras: the web console's settings, from FlyBot (services/camosSettings.js)
router.get('/cameras/:serial/device-settings', cameraController.getDeviceSettings);
router.put('/cameras/:serial/device-settings', express.json({ limit: '16kb' }), cameraController.updateDeviceSettings);

// Stream & playback routes
router.post('/live', cameraController.getLiveStream);
router.post('/live/disable', cameraController.disableStream);
router.post('/records', cameraController.getRecords);
router.post('/playback', cameraController.getPlaybackStream);

module.exports = router;

