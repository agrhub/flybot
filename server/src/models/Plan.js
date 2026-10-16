const mongoose = require('mongoose');

/**
 * A subscription plan (FREE / PRO / ENTERPRISE), configured by the admin (Admin > Plans) and
 * read through services/planService.js. Seeded on first use with placeholder numbers the admin
 * edits. For maxCameras and maxMembers, 0 means no limit. No prices: priceNote is free text
 * (for example "Lien he"). Payment is manual (upgrade requests).
 */
const PLAN_CODES = ['free', 'pro', 'enterprise'];

const planSchema = new mongoose.Schema({
    code: { type: String, enum: PLAN_CODES, required: true, unique: true },
    name: { type: String, required: true, trim: true },
    // Cameras in one workspace (0 = no limit); add-ons are on the workspace
    maxCameras: { type: Number, min: 0, default: 3 },
    // Photos per camera in any 24 hours
    snapshotsPerDay: { type: Number, min: 1, default: 48 },
    retentionDays: { type: Number, min: 1, default: 30 },
    // LLM deep analysis (the chatbot's analyze_photo_deep) per workspace per calendar month (0 = none)
    deepAnalysisPerMonth: { type: Number, min: 0, default: 20 },
    liveMinutesPerRequest: { type: Number, min: 1, max: 60, default: 5 },
    // People in the workspace, owner included (0 = no limit)
    maxMembers: { type: Number, min: 0, default: 1 },
    features: {
        telegram: { type: Boolean, default: true },
        pdfReports: { type: Boolean, default: false },
        apiAndWebhooks: { type: Boolean, default: false }
    },
    priceNote: { type: String, default: '', trim: true, maxlength: 200 },
    description: { type: String, default: '', trim: true, maxlength: 500 },
    // Shown on the pricing page
    visible: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

const Plan = mongoose.model('Plan', planSchema);

module.exports = Plan;
module.exports.PLAN_CODES = PLAN_CODES;
