const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

const { authenticate } = require('../middlewares/auth');
const { loginLimiter, registerLimiter, passwordChangeLimiter } = require('../middlewares/rateLimit');

router.post('/register', registerLimiter, authController.register);
router.post('/login', loginLimiter, authController.login);
router.post('/logout', authController.logout);
router.post('/session', authenticate, authController.refreshSession);
router.post('/change-password', authenticate, passwordChangeLimiter, authController.changePassword);
router.post('/profile', authenticate, authController.updateProfile);

module.exports = router;
