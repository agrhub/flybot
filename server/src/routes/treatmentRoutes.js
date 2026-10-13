const express = require('express');
const router = express.Router();
const { reportSendLimiter, analyticsLimiter } = require('../middlewares/rateLimit');
const treatmentController = require('../controllers/treatmentController');
const { authenticate } = require('../middlewares/auth');
const { requireStringFields } = require('../middlewares/validate');

router.use(authenticate, requireStringFields);

// Anyone sees treatments on cameras they can see; changes need management rights on every camera
router.get('/', treatmentController.listTreatments);
router.get('/withholding', treatmentController.listWithholding);
router.get('/effectiveness', analyticsLimiter, treatmentController.getEffectiveness);
// Same hourly quota as "Email me" for reports: each sends a PDF
router.post('/vietgap/send', reportSendLimiter, treatmentController.sendVietGapRecord);
router.post('/', treatmentController.createTreatment);
router.get('/:id/effect', treatmentController.getEffect);
router.put('/:id', treatmentController.updateTreatment);
router.delete('/:id', treatmentController.deleteTreatment);

module.exports = router;
