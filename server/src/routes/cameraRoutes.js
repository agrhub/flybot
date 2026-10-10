const express = require('express');
const router = express.Router();
const cameraController = require('../controllers/cameraController');
const { authenticate } = require('../middlewares/auth');
const { requireStringFields } = require('../middlewares/validate');

// Apply authentication to all camera routes
router.use(authenticate);
router.use(requireStringFields);

// User camera management
router.get('/user/cameras', cameraController.getUserCameras);
router.post('/user/add-camera', cameraController.addCamera);
router.put('/user/camera', cameraController.updateCamera);
router.post('/user/update-camera', cameraController.updateCamera);
router.put('/user/camera/location', cameraController.updateCameraLocation);
router.post('/user/update-camera-location', cameraController.updateCameraLocation);
router.delete('/user/delete-camera', cameraController.deleteCamera);
router.post('/user/update-camera-code', cameraController.updateCameraCode);

// Stream & playback routes
router.post('/live', cameraController.getLiveStream);
router.post('/live/disable', cameraController.disableStream);
router.post('/records', cameraController.getRecords);
router.post('/playback', cameraController.getPlaybackStream);

module.exports = router;

