const express = require('express');
const router = express.Router();
const systemController = require('../controllers/systemController');
const { authenticate } = require('../middlewares/auth');

router.use(authenticate);
router.get('/info', systemController.getSystemInfo);

module.exports = router;
