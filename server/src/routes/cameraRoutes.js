const express = require('express');
const router = express.Router();
const cameraController = require('../controllers/cameraController');
const shareController = require('../controllers/shareController');
const { authenticate, requireRole } = require('../middlewares/auth');
const { requireStringFields } = require('../middlewares/validate');
const { rateLimit } = require('../middlewares/rateLimit');

// Manual captures hit the camera and the AI API: at most 3 per camera per user per minute
const captureLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 3,
    includeIp: false,
    keyFn: (req) => `${req.user?.id}:${req.body?.deviceSerial}`
});

// Apply authentication to all camera routes
router.use(authenticate);
router.use(requireStringFields);

// User camera management
router.get('/user/cameras', cameraController.getUserCameras);
// Viewers (role "user") cannot register cameras; edit/delete/share check ownership per camera
router.post('/user/add-camera', requireRole('admin', 'manager'), cameraController.addCamera);
router.put('/user/camera', cameraController.updateCamera);
router.post('/user/update-camera', cameraController.updateCamera);
router.put('/user/camera/location', cameraController.updateCameraLocation);
router.post('/user/update-camera-location', cameraController.updateCameraLocation);
router.delete('/user/delete-camera', cameraController.deleteCamera);
router.post('/user/update-camera-code', cameraController.updateCameraCode);
router.get('/user/cameras/health', cameraController.getCamerasHealth);
router.get('/user/camera/shares', shareController.listShares);
router.post('/user/camera/share', shareController.addShare);
router.delete('/user/camera/share', shareController.removeShare);
router.post('/user/camera/capture', captureLimiter, cameraController.captureNow);

// Stream & playback routes
router.post('/live', cameraController.getLiveStream);
router.post('/live/disable', cameraController.disableStream);
router.post('/records', cameraController.getRecords);
router.post('/playback', cameraController.getPlaybackStream);

module.exports = router;

