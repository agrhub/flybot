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
    resendVerificationLimiter,
    avatarLimiter
} = require('../middlewares/rateLimit');
const { AVATAR_MAX_BYTES } = require('../services/avatarService');

// The picture arrives as the request body; a larger one is refused with a clear message
function readAvatarBody(req, res, next) {
    express.raw({ type: ['image/jpeg', 'image/png'], limit: AVATAR_MAX_BYTES })(req, res, (err) => {
        if (err?.type === 'entity.too.large') return res.status(400).json({ success: false, message: "The image must be 2 MB or smaller." });
        if (err) return next(err);
        if (!Buffer.isBuffer(req.body)) return res.status(400).json({ success: false, message: "Please choose a JPG or PNG image." });
        next();
    });
}

router.use(requireStringFields);

router.post('/register', registerLimiter, authController.register);
router.post('/login', loginLimiter, authController.login);
router.post('/logout', authController.logout);
router.post('/forgot-password', forgotPasswordLimiter, authController.forgotPassword);
router.post('/reset-password', tokenLimiter, authController.resetPassword);
router.post('/verify-email', tokenLimiter, authController.verifyEmail);
router.post('/resend-verification', authenticate, resendVerificationLimiter, authController.resendVerification);
router.post('/session', authenticate, authController.refreshSession);
router.get('/config', authController.getAuthConfig);
router.get('/me', authenticate, authController.getMe);
router.get('/sessions', authenticate, authController.listSessions);
router.post('/sessions/revoke-others', authenticate, authController.revokeOtherSessions);
router.delete('/sessions/:sessionId', authenticate, authController.revokeSession);
router.post('/change-password', authenticate, passwordChangeLimiter, authController.changePassword);
router.post('/profile', authenticate, authController.updateProfile);
router.get('/avatar', authenticate, authController.getAvatar);
router.get('/avatars/:userId', authenticate, authController.getUserAvatar);
router.post('/avatar', authenticate, avatarLimiter, readAvatarBody, authController.uploadAvatar);
router.delete('/avatar', authenticate, avatarLimiter, authController.deleteAvatar);

module.exports = router;
