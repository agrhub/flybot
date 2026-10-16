const mongoose = require('mongoose');

/**
 * A workspace: the "personal" one every account gets at sign-up (APP_MODE b2c / hybrid), or an
 * "organization" (a farm business, cooperative or team) made by the admin. It groups people,
 * cameras, farms and dashboards (Camera.orgId / Farm.orgId / Dashboard.orgId = the workspace)
 * and carries the plan (FREE / PRO / ENTERPRISE, services/entitlements.js).
 * Members see every camera and farm of the organization; its owners and managers also
 * manage them (when their account role allows managing cameras).
 *
 * Camera access is kept in the cameras' share lists, marked viaOrg
 * (services/orgService.js keeps them in step), so every existing access check applies.
 */
const ORG_ROLES = ['owner', 'manager', 'member'];

const memberSchema = new mongoose.Schema({
    // null until the invited email has a verified account
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, enum: ORG_ROLES, default: 'member' },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    addedAt: { type: Date, default: Date.now }
}, { _id: false });

const workspacePlanSchema = new mongoose.Schema({
    code: { type: String, enum: ['free', 'pro', 'enterprise'], default: 'free' },
    // Cameras on top of the plan's maxCameras
    addonCameras: { type: Number, min: 0, default: 0 },
    // A paid plan past this date falls back to FREE (data kept, adding blocked); null = no end
    expiresAt: { type: Date, default: null },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    assignedAt: { type: Date, default: null },
    note: { type: String, default: '', trim: true, maxlength: 500 }
}, { _id: false });

// Automatic payments (services/payments): how the plan is paid and renewed. Empty for plans the
// admin assigned by hand.
const billingSchema = new mongoose.Schema({
    // payos | stripe once paid online; then a late renewal gets the grace period
    provider: { type: String, default: null },
    // Stripe renews on its own; PayOS is paid again each period (reminders)
    autoRenew: { type: Boolean, default: false },
    // A renewal failed: the plan still works until graceUntil, then falls back to FREE
    pastDue: { type: Boolean, default: false },
    graceUntil: { type: Date, default: null },
    nextRetryAt: { type: Date, default: null },
    subscriptionRef: { type: String, default: null },
    customerRef: { type: String, default: null },
    lastPaymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },
    // Reminders already sent ("<expiresAt ISO>|7d"), so the daily job sends each once
    notices: { type: [String], default: undefined }
}, { _id: false });

const organizationSchema = new mongoose.Schema({
    // Simulated demo data (scripts/demo_sim.js): labeled wherever it is shown, never mixed with real data
    simulated: { type: Boolean, default: undefined },
    name: { type: String, required: true, trim: true },
    // personal: one owner, made with the account; organization: made by the admin
    kind: { type: String, enum: ['personal', 'organization'], default: 'organization' },
    members: { type: [memberSchema], default: [] },
    plan: { type: workspacePlanSchema, default: () => ({}) },
    billing: { type: billingSchema, default: undefined },
    settings: {
        // An organization's owner may hide the members' personal workspaces (they keep their data)
        allowMemberPersonalWorkspaces: { type: Boolean, default: true }
    },
    // Manual invoices / contract (admin only)
    billingNote: { type: String, default: '', trim: true, maxlength: 1000 },
    // Hooks for later (no UI yet): sign-ups with these email domains join automatically, and a
    // subdomain of its own
    emailDomains: { type: [String], default: undefined },
    subdomain: { type: String, default: undefined, trim: true, lowercase: true }
}, { timestamps: true });

organizationSchema.index({ 'members.userId': 1 });
organizationSchema.index({ 'members.email': 1 });
organizationSchema.index({ kind: 1 });

const Organization = mongoose.model('Organization', organizationSchema);

module.exports = Organization;
module.exports.ORG_ROLES = ORG_ROLES;
