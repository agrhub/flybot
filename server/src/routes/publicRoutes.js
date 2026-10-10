const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');
const { rateLimit } = require('../middlewares/rateLimit');

// No sign-in here: slow down token guessing and scraping
const publicLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
// A page load fetches one image per camera
const publicImageLimiter = rateLimit({ windowMs: 60 * 1000, max: 600 });

router.get('/dashboards/:token', publicLimiter, dashboardController.getPublicDashboard);
router.get('/dashboards/:token/images/*key', publicImageLimiter, dashboardController.streamPublicImage);

module.exports = router;
