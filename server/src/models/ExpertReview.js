const mongoose = require('mongoose');
const { VERDICTS } = require('../config/expertReview');

/**
 * The answers of one expert review page (config/expertReview.js), one document per page token.
 * Each answer keeps the time the reviewer last changed it (`t`, ms from the page's clock), so a save
 * from a second device or an old tab never replaces a newer answer.
 */
const answerSchema = new mongoose.Schema({
    id: { type: String, required: true, maxlength: 10 },
    verdict: { type: String, enum: ['', ...VERDICTS], default: '' },
    note: { type: String, default: '', maxlength: 1000 },
    t: { type: Number, default: 0 }
}, { _id: false });

const expertReviewSchema = new mongoose.Schema({
    token: { type: String, required: true, unique: true },
    answers: { type: [answerSchema], default: [] },
    // Last time the reviewer pressed "send" (the answers were emailed)
    sentAt: { type: Date, default: null }
}, { timestamps: true });

const ExpertReview = mongoose.model('ExpertReview', expertReviewSchema);

module.exports = ExpertReview;
