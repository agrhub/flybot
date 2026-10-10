const express = require('express');
const router = express.Router();
const farmController = require('../controllers/farmController');
const { authenticate, requireRole } = require('../middlewares/auth');
const { requireStringFields } = require('../middlewares/validate');
const { shareLimiter } = require('../middlewares/rateLimit');

router.use(authenticate, requireStringFields);

router.get('/', farmController.listFarms);
router.get('/map', farmController.mapPlots);
// Viewers (role "user") only see farms shared with them
router.post('/', requireRole('admin', 'manager'), farmController.createFarm);
router.get('/:id', farmController.getFarm);
router.put('/:id', farmController.updateFarm);
router.delete('/:id', farmController.deleteFarm);
router.post('/:id/plots', farmController.createPlot);
router.put('/:id/plots/:plotId', farmController.updatePlot);
router.delete('/:id/plots/:plotId', farmController.deletePlot);
router.put('/:id/plots/:plotId/cameras', farmController.setPlotCameras);
router.post('/:id/share', shareLimiter, farmController.shareFarm);
router.delete('/:id/share', farmController.unshareFarm);

module.exports = router;
