const mongoose = require('mongoose');

/**
 * A request for a bigger plan, more cameras, or a new organization (services/upgradeService.js).
 * The admin approves (setting the workspace's plan, add-ons and expiry) or rejects with a note;
 * payment is handled outside FlyBot (`paid` is the admin's checkbox).
 *
 * status: pending_owner (APP_MODE b2b: a member asked, the organization's owner looks first)
 *         -> pending (waiting for the admin) -> approved | rejected; cancelled by the requester.
 */
const STATUSES = ['pending_owner', 'pending', 'approved', 'rejected', 'cancelled'];
const TYPES = ['plan', 'organization'];

const upgradeRequestSchema = new mongoose.Schema({
    type: { type: String, enum: TYPES, default: 'plan' },
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    targetPlan: { type: String, enum: ['free', 'pro', 'enterprise'], default: 'pro' },
    extraCameras: { type: Number, min: 0, max: 10000, default: 0 },
    message: { type: String, default: '', trim: true, maxlength: 1000 },
    // type "organization": what the person told us about it
    organization: {
        name: { type: String, default: undefined, trim: true, maxlength: 120 },
        cameras: { type: Number, default: undefined, min: 0, max: 100000 },
        members: { type: Number, default: undefined, min: 0, max: 100000 },
        phone: { type: String, default: undefined, trim: true, maxlength: 40 }
    },
    // The limit that was hit when the request was made (cameras, deepAnalysis, members...)
    reason: { type: String, default: '', maxlength: 60 },
    status: { type: String, enum: STATUSES, default: 'pending', index: true },
    adminNote: { type: String, default: '', trim: true, maxlength: 1000 },
    paid: { type: Boolean, default: false },
    forwardedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    // What the approval set
    granted: {
        plan: { type: String, default: undefined },
        addonCameras: { type: Number, default: undefined },
        expiresAt: { type: Date, default: undefined },
        workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: undefined }
    }
}, { timestamps: true });

upgradeRequestSchema.index({ status: 1, createdAt: -1 });

const UpgradeRequest = mongoose.model('UpgradeRequest', upgradeRequestSchema);

module.exports = UpgradeRequest;
module.exports.STATUSES = STATUSES;
module.exports.TYPES = TYPES;
