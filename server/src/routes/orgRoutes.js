const express = require('express');
const router = express.Router();
const orgController = require('../controllers/orgController');
const { authenticate, requireRole } = require('../middlewares/auth');
const { requireStringFields } = require('../middlewares/validate');
const { shareLimiter, analyticsLimiter, reportSendLimiter } = require('../middlewares/rateLimit');

router.use(authenticate, requireStringFields);

router.get('/', orgController.listOrgs);
router.get('/:id/overview', analyticsLimiter, orgController.getOverview);
router.post('/:id/remind', shareLimiter, orgController.remindLog);
router.get('/:id/report', analyticsLimiter, orgController.downloadReport);
router.post('/:id/report/send', reportSendLimiter, orgController.sendReport);
// Viewers (role "user") join organizations but do not create them
router.post('/', requireRole('admin', 'manager'), orgController.createOrg);
router.put('/:id', orgController.updateOrg);
router.delete('/:id', orgController.deleteOrg);
router.post('/:id/members', shareLimiter, orgController.addMember);
router.post('/:id/members/remind', shareLimiter, orgController.remindMember);
router.post('/:id/members/bulk', shareLimiter, orgController.addMembersBulk);
router.put('/:id/members', orgController.updateMember);
router.delete('/:id/members', orgController.removeMember);
router.put('/:id/cameras', orgController.setCameras);

module.exports = router;
