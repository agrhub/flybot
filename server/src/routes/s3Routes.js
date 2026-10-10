const express = require('express');
const router = express.Router();
const s3Controller = require('../controllers/s3Controller');
const { authenticate } = require('../middlewares/auth');

router.use(authenticate);
router.get('/*key', s3Controller.streamS3File);

module.exports = router;
