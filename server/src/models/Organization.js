const mongoose = require('mongoose');

/**
 * An organization (a farm business, cooperative or team) groups people, cameras and farms.
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

const organizationSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    members: { type: [memberSchema], default: [] }
}, { timestamps: true });

organizationSchema.index({ 'members.userId': 1 });
organizationSchema.index({ 'members.email': 1 });

const Organization = mongoose.model('Organization', organizationSchema);

module.exports = Organization;
module.exports.ORG_ROLES = ORG_ROLES;
