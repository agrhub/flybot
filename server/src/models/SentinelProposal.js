const mongoose = require('mongoose');

const PROPOSAL_TYPES = ['card_change', 'treatment'];
const PROPOSAL_STATES = ['pending', 'confirmed', 'rejected', 'failed', 'expired'];
// Kept for a year after creation, like the audit log
const RETENTION_DAYS = 365;

/**
 * A change FlyBot Sentinel proposed (POST /api/sentinel/proposals). The person sees it as the
 * same confirm card the assistant makes (ChatSession `sessionId` "sentinel", card `cardIndex`
 * of message `messageId`) and in Telegram; nothing is recorded until they confirm it.
 * `state` is updated when they decide (aiController.decideCard).
 */
const sentinelProposalSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: PROPOSAL_TYPES, required: true },
    deviceSerials: { type: [String], default: [] },
    sessionId: { type: String, required: true },
    messageId: { type: String, required: true, unique: true },
    cardIndex: { type: Number, default: 0 },
    reason: { type: String, default: '' },
    evidence: { type: [{ _id: false, url: String, snapshotId: String, caption: String }], default: [] },
    state: { type: String, enum: PROPOSAL_STATES, default: 'pending' },
    result: { type: String, default: '' },
    decidedAt: { type: Date, default: null },
    decidedVia: { type: String, enum: ['app', 'telegram', null], default: null },
    expiresAt: { type: Date, required: true },
    telegram: {
        chatId: { type: String, default: undefined },
        messageId: { type: Number, default: undefined }
    },
    createdAt: { type: Date, default: Date.now, index: { expires: RETENTION_DAYS * 24 * 60 * 60 } }
});

const SentinelProposal = mongoose.model('SentinelProposal', sentinelProposalSchema);

module.exports = SentinelProposal;
module.exports.PROPOSAL_TYPES = PROPOSAL_TYPES;
module.exports.PROPOSAL_STATES = PROPOSAL_STATES;
