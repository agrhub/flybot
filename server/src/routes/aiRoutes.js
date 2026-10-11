const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');
const { authenticate } = require('../middlewares/auth');
const { requireStringFields } = require('../middlewares/validate');
const { chatLimiter } = require('../middlewares/rateLimit');

router.use(authenticate);
router.use(requireStringFields);

router.get('/results', aiController.getAiResults);
router.post('/analyze-roboflow/:snapshotId', aiController.analyzeRoboflowSnapshot);
router.get('/statistics', aiController.getAiStatistics);
router.get('/overview', aiController.getAiOverview);
router.get('/comparison', aiController.getAiComparison);
router.get('/insights', aiController.getAiInsights);
router.put('/snapshots/:snapshotId/review', aiController.reviewSnapshot);
router.get('/reviews/export', aiController.exportReviews);
router.post('/diagnose', aiController.getAiDiagnosis);
router.post('/chat', chatLimiter, aiController.chatWithAssistant);
router.post('/chat/stream', chatLimiter, aiController.chatWithAssistantStream);
router.get('/chat/history', aiController.getChatHistory);
router.post('/chat/feedback', aiController.rateChatMessage);
router.post('/chat/confirm', aiController.confirmChatAction);
router.post('/chat/clear', aiController.clearChatSession);

module.exports = router;
