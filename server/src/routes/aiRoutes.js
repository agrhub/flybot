const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');
const { authenticate } = require('../middlewares/auth');
const { requireStringFields } = require('../middlewares/validate');

router.use(authenticate);
router.use(requireStringFields);

router.get('/results', aiController.getAiResults);
router.post('/analyze-roboflow/:snapshotId', aiController.analyzeRoboflowSnapshot);
router.get('/statistics', aiController.getAiStatistics);
router.get('/overview', aiController.getAiOverview);
router.get('/comparison', aiController.getAiComparison);
router.post('/diagnose', aiController.getAiDiagnosis);
router.post('/chat', aiController.chatWithAssistant);
router.post('/chat/clear', aiController.clearChatSession);

module.exports = router;
