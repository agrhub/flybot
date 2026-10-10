const mongoose = require('mongoose');

// Entries are kept for a year, then removed by MongoDB (TTL index)
const AUDIT_RETENTION_DAYS = 365;

/**
 * Who did what to which object, for security reviews and support.
 * Labels (email, camera name...) are copied at write time so entries stay readable
 * after the user or object is renamed or deleted.
 */
const auditLogSchema = new mongoose.Schema({
    action: { type: String, required: true },
    // "auth", "user", "camera", "dashboard", "settings" (the part of the action before the dot)
    category: { type: String, required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorEmail: { type: String, default: '' },
    targetType: { type: String, default: '' },
    targetId: { type: String, default: '' },
    targetLabel: { type: String, default: '' },
    details: { type: mongoose.Schema.Types.Mixed, default: undefined },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now }
});

auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: AUDIT_RETENTION_DAYS * 24 * 60 * 60 });
auditLogSchema.index({ category: 1, createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

module.exports = AuditLog;
module.exports.AUDIT_RETENTION_DAYS = AUDIT_RETENTION_DAYS;
