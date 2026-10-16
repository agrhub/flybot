const express = require('express');
const billingController = require('../controllers/billingController');
const { authenticate } = require('../middlewares/auth');
const { rateLimit } = require('../middlewares/rateLimit');

/**
 * Paying for the current workspace's plan online (API.md "Payments"). Mounted at /api/billing.
 */
const router = express.Router();

router.use(authenticate);

// Each checkout calls the payment provider
const checkoutLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, keyFn: (req) => String(req.user?.id || ''), message: 'Too many requests. Please try again in a moment.' });

router.get('/', billingController.getSummary);
router.post('/checkout', checkoutLimiter, billingController.createCheckout);
router.get('/payments', billingController.listPayments);
router.get('/payments/:id', billingController.getPayment);
router.post('/cancel-renewal', billingController.cancelRenewal);

module.exports = router;
