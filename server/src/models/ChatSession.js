const mongoose = require('mongoose');

// Conversations are kept this long after their last message
const CHAT_RETENTION_DAYS = 7;
// Messages kept for display (the model sees a shorter history, agent/agent.js)
const MAX_CHAT_MESSAGES = 60;

/**
 * One assistant conversation of a user (agent/agent.js).
 *  - contents: the history the model is given (questions, tool calls and results, answers)
 *  - messages: what the chat panel shows again after a reload, with the answer's cards and the
 *    user's rating of it
 */
const messageSchema = new mongoose.Schema({
    id: { type: String, required: true },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, default: '' },
    cards: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    tools: { type: [{ _id: false, name: String, status: String, message: String }], default: undefined },
    suggestions: { type: [String], default: undefined },
    feedback: {
        type: new mongoose.Schema({
            rating: { type: String, enum: ['up', 'down'], required: true },
            at: { type: Date, default: Date.now }
        }, { _id: false }),
        default: undefined
    },
    at: { type: Date, default: Date.now }
}, { _id: false });

const chatSessionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sessionId: { type: String, required: true },
    contents: { type: [mongoose.Schema.Types.Mixed], default: [] },
    messages: { type: [messageSchema], default: [] },
    updatedAt: { type: Date, default: Date.now, index: { expires: CHAT_RETENTION_DAYS * 24 * 60 * 60 } }
});

chatSessionSchema.index({ userId: 1, sessionId: 1 }, { unique: true });
// Rated answers, newest first (reviewing what the assistant got wrong)
chatSessionSchema.index({ 'messages.feedback.rating': 1, updatedAt: -1 }, { sparse: true });

const ChatSession = mongoose.model('ChatSession', chatSessionSchema);

module.exports = ChatSession;
module.exports.CHAT_RETENTION_DAYS = CHAT_RETENTION_DAYS;
module.exports.MAX_CHAT_MESSAGES = MAX_CHAT_MESSAGES;
