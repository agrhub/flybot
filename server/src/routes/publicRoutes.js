const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');
const contactController = require('../controllers/contactController');
const expertReviewController = require('../controllers/expertReviewController');
const { rateLimit } = require('../middlewares/rateLimit');

// No sign-in here: slow down token guessing and scraping
const publicLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
// A page load fetches one image per camera
const publicImageLimiter = rateLimit({ windowMs: 60 * 1000, max: 600 });

router.get('/dashboards/:token', publicLimiter, dashboardController.getPublicDashboard);
router.get('/dashboards/:token/images/*key', publicImageLimiter, dashboardController.streamPublicImage);

// Contact form: a few messages per visitor per hour
router.post('/contact', rateLimit({ windowMs: 60 * 60 * 1000, max: 5 }), contactController.submitContact);

// The advisor's expert review page saves as it goes (every few seconds while answering)
router.get('/expert-review/:token', publicLimiter, expertReviewController.getReview);
router.post('/expert-review/:token', rateLimit({ windowMs: 60 * 60 * 1000, max: 600 }), expertReviewController.saveReview);

module.exports = router;
