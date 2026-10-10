const express = require('express');
const router = express.Router();
const treatmentController = require('../controllers/treatmentController');
const { authenticate } = require('../middlewares/auth');
const { requireStringFields } = require('../middlewares/validate');

router.use(authenticate, requireStringFields);

// Anyone sees treatments on cameras they can see; changes need management rights on every camera
router.get('/', treatmentController.listTreatments);
router.post('/', treatmentController.createTreatment);
router.get('/:id/effect', treatmentController.getEffect);
router.put('/:id', treatmentController.updateTreatment);
router.delete('/:id', treatmentController.deleteTreatment);

module.exports = router;
