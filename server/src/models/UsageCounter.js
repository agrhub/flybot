const mongoose = require('mongoose');

/**
 * What a workspace used in a calendar month (UTC), for limits counted per month: LLM deep
 * analyses (services/entitlements.js). One document per workspace and month.
 */
const usageCounterSchema = new mongoose.Schema({
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    month: { type: String, required: true }, // YYYY-MM
    deepAnalyses: { type: Number, default: 0 }
}, { timestamps: true });

usageCounterSchema.index({ workspaceId: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('UsageCounter', usageCounterSchema);
