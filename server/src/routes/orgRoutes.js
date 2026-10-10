const express = require('express');
const router = express.Router();
const orgController = require('../controllers/orgController');
const { authenticate, requireRole } = require('../middlewares/auth');
const { requireStringFields } = require('../middlewares/validate');
const { shareLimiter } = require('../middlewares/rateLimit');

router.use(authenticate, requireStringFields);

router.get('/', orgController.listOrgs);
// Viewers (role "user") join organizations but do not create them
router.post('/', requireRole('admin', 'manager'), orgController.createOrg);
router.put('/:id', orgController.updateOrg);
router.delete('/:id', orgController.deleteOrg);
router.post('/:id/members', shareLimiter, orgController.addMember);
router.put('/:id/members', orgController.updateMember);
router.delete('/:id/members', orgController.removeMember);
router.put('/:id/cameras', orgController.setCameras);

module.exports = router;
