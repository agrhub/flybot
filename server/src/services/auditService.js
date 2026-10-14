const { AuditLog } = require('../models');

const AUDIT_ACTIONS = [
    'auth.register',
    'auth.login',
    'auth.login_failed',
    'auth.password_reset',
    'auth.password_changed',
    'auth.sessions_revoked',
    'auth.data_exported',
    'user.role_changed',
    'user.disabled',
    'user.enabled',
    'user.email_verified',
    'user.deleted',
    'user.confirm_reminded',
    'camera.added',
    'camera.updated',
    'camera.deleted',
    'camera.shared',
    'camera.unshared',
    'camera.transferred',
    'dashboard.created',
    'dashboard.deleted',
    'dashboard.shared',
    'dashboard.unshared',
    'dashboard.published',
    'dashboard.unpublished',
    'dashboard.link_rotated',
    'dashboard.expiry_changed',
    'dashboard.schedule_changed',
    'settings.updated',
    'treatment.created',
    'treatment.updated',
    'treatment.deleted',
    'treatment.imported',
    'farm.created',
    'farm.deleted',
    'farm.shared',
    'farm.unshared',
    'farm.cameras_changed',
    'org.created',
    'org.updated',
    'org.deleted',
    'org.member_added',
    'org.members_added',
    'org.member_updated',
    'org.member_removed',
    'org.member_reminded',
    'org.cameras_changed',
    'integration.key_created',
    'integration.key_revoked',
    'integration.webhook_created',
    'integration.webhook_updated',
    'integration.webhook_deleted'
];
const CATEGORIES = [...new Set(AUDIT_ACTIONS.map(a => a.split('.')[0]))];

const MAX_DETAIL_KEYS = 12;
const clip = (value, max = 200) => String(value ?? '').slice(0, max);

// Small, flat, string/number/boolean details only (never passwords or tokens)
function cleanDetails(details) {
    if (!details || typeof details !== 'object') return undefined;
    const out = {};
    for (const [key, value] of Object.entries(details).slice(0, MAX_DETAIL_KEYS)) {
        if (value === undefined) continue;
        if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
        else if (Array.isArray(value)) out[key] = value.slice(0, 20).map(v => clip(v, 60));
        else out[key] = clip(value);
    }
    return Object.keys(out).length ? out : undefined;
}

/**
 * Record one audit entry. Never throws and never delays the response:
 * a failed write is logged and dropped.
 *  - req:    the request (actor from req.user, plus IP and user agent); may be null for jobs
 *  - actor:  overrides req.user, e.g. { id, email } right after sign-in, or { email } for a failed one
 *  - target: { type, id, label }
 */
function recordAudit(req, { action, actor, target = {}, details } = {}) {
    if (!AUDIT_ACTIONS.includes(action)) {
        console.warn(`⚠️ Unknown audit action "${action}"`);
        return Promise.resolve(null);
    }
    const who = actor || req?.user || {};
    const entry = {
        action,
        category: action.split('.')[0],
        actorId: who.id || who._id || null,
        actorEmail: clip(who.email, 254).toLowerCase(),
        targetType: clip(target.type, 30),
        targetId: clip(target.id, 100),
        targetLabel: clip(target.label),
        details: cleanDetails(details),
        ip: clip(req?.ip, 64),
        userAgent: clip(req?.headers?.['user-agent'], 300)
    };
    return AuditLog.create(entry).catch((err) => {
        console.error('⚠️ Audit log write failed:', err.message);
        return null;
    });
}

module.exports = {
    AUDIT_ACTIONS,
    CATEGORIES,
    recordAudit
};
