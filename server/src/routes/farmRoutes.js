const express = require('express');
const router = express.Router();
const farmController = require('../controllers/farmController');
const { authenticate, requireRole } = require('../middlewares/auth');
const { requireStringFields } = require('../middlewares/validate');
const { requireWorkspaceRole } = require('../services/entitlements');
const { shareLimiter, analyticsLimiter, reportSendLimiter } = require('../middlewares/rateLimit');

// Organization roles: members see (and owners/managers edit) the organization's farms
router.use(authenticate, requireStringFields, require('../services/orgService').attachOrgRoles);

router.get('/', farmController.listFarms);
router.get('/map', farmController.mapPlots);
router.get('/compare', analyticsLimiter, farmController.compareFarms);
router.get('/plan', analyticsLimiter, farmController.getPlan);
router.get('/season-report', analyticsLimiter, farmController.downloadSeasonReport);
router.post('/season-report/send', reportSendLimiter, farmController.sendSeasonReport);
// Viewers (role "user") only see farms shared with them
router.post('/', requireWorkspaceRole, farmController.createFarm);
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
