const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    email: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    name: { type: String, default: '' },
    avatar: { type: String, default: '' },
    // admin: full control | manager: owns and shares cameras, builds dashboards | user: views shared items
    // (accounts created before roles existed get one from services/migrations.js at startup)
    // System role: admin (platform operator) | support (read-only admin pages) | user. What an
    // account may do with cameras comes from its workspaces and their plans (services/entitlements.js);
    // "manager" is the retired global role, moved to "user" by the workspaces-v1 migration
    role: { type: String, enum: ['admin', 'support', 'manager', 'user'], default: 'user' },
    // The workspace the app shows (null = the personal one, or the first)
    currentWorkspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },
    // Disabled accounts cannot sign in; set by an admin
    disabled: { type: Boolean, default: false },
    // Read-only access to the FlyBot Sentinel pages for a "user" account (e.g. a competition judge);
    // admins and managers have it anyway. Set by an admin (PUT /api/admin/users/:id)
    sentinelViewer: { type: Boolean, default: false },
    emailVerified: { type: Boolean, default: false },
    // UI/email language: 'vi' | 'en'
    language: { type: String, default: 'vi' },
    // Embedded in login tokens; bumping it signs out every existing session
    tokenVersion: { type: Number, default: 0 },
    notificationPrefs: {
        // Alert emails are only sent to verified addresses
        email: { type: Boolean, default: true },
        telegram: { type: Boolean, default: true },
        // Monday summary of the past week
        weeklyReport: { type: Boolean, default: true },
        // Short summary every morning at 06:30 (Telegram, else email); off unless turned on
        morningBrief: { type: Boolean, default: false },
        // The month's pesticide-use record (VietGAP) on the 1st
        vietgapMonthly: { type: Boolean, default: false },
        // Owners and managers of a cooperative: Monday list of members to visit
        orgDigest: { type: Boolean, default: true },
        // No push / Telegram during these local hours (in-app and email still arrive)
        quietHours: {
            enabled: { type: Boolean, default: false },
            start: { type: String, default: '21:00' },
            end: { type: String, default: '06:00' }
        },
        // Cameras this person does not want any notification from
        mutedCameras: { type: [String], default: [] }
    },
    // EZVIZ sub-account for the browser player (services/ezvizRamService.js)
    ezvizRam: {
        accountId: { type: String, default: undefined },
        policyHash: { type: String, default: undefined },
        syncedAt: { type: Date, default: undefined }
    },
    // Linked Telegram chat for alerts (set by the bot after the user presses Start)
    telegram: {
        chatId: { type: String, default: undefined },
        username: { type: String, default: undefined },
        linkedAt: { type: Date, default: undefined }
    },
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

module.exports = User;
