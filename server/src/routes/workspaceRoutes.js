const express = require('express');
const workspaceController = require('../controllers/workspaceController');
const { authenticate } = require('../middlewares/auth');
const { requireStringFields } = require('../middlewares/validate');
const { rateLimit } = require('../middlewares/rateLimit');

/**
 * Workspaces, plans and upgrade requests (API.md "Workspaces and plans").
 * Mounted at /api: /plans (public), /me/entitlements, /workspaces, /upgrade-requests.
 */
const router = express.Router();

// The pricing page reads the plans before anyone signs in
router.get('/plans', workspaceController.listPlans);

router.get('/me/entitlements', authenticate, workspaceController.getMyEntitlements);
router.get('/workspaces', authenticate, workspaceController.listMine);
router.put('/workspaces/current', authenticate, requireStringFields, workspaceController.setCurrent);
router.put('/workspaces/:id/settings', authenticate, workspaceController.updateSettings);

const requestLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, keyFn: (req) => String(req.user?.id || ''), message: 'Too many requests.' });
router.post('/upgrade-requests', authenticate, requestLimiter, workspaceController.createRequest);
router.get('/upgrade-requests', authenticate, workspaceController.listRequests);
router.post('/upgrade-requests/:id/cancel', authenticate, workspaceController.cancelRequest);
router.post('/upgrade-requests/:id/forward', authenticate, workspaceController.forwardRequest);

module.exports = router;
