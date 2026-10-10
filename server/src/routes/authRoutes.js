const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

const { authenticate } = require('../middlewares/auth');
const { requireStringFields } = require('../middlewares/validate');
const {
    loginLimiter,
    registerLimiter,
    passwordChangeLimiter,
    forgotPasswordLimiter,
    tokenLimiter,
    resendVerificationLimiter
} = require('../middlewares/rateLimit');

router.use(requireStringFields);

router.post('/register', registerLimiter, authController.register);
router.post('/login', loginLimiter, authController.login);
router.post('/logout', authController.logout);
router.post('/forgot-password', forgotPasswordLimiter, authController.forgotPassword);
router.post('/reset-password', tokenLimiter, authController.resetPassword);
router.post('/verify-email', tokenLimiter, authController.verifyEmail);
router.post('/resend-verification', authenticate, resendVerificationLimiter, authController.resendVerification);
router.post('/session', authenticate, authController.refreshSession);
router.get('/me', authenticate, authController.getMe);
router.post('/change-password', authenticate, passwordChangeLimiter, authController.changePassword);
router.post('/profile', authenticate, authController.updateProfile);

module.exports = router;
