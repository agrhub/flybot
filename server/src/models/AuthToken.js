const mongoose = require('mongoose');

/**
 * One-time tokens for password reset and email verification.
 * Only the SHA-256 hash is stored, so a database leak does not expose usable links.
 */
const authTokenSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['password_reset', 'email_verify', 'telegram_link'], required: true },
    tokenHash: { type: String, required: true, unique: true },
    usedAt: { type: Date, default: null },
    // MongoDB removes expired tokens automatically
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    createdAt: { type: Date, default: Date.now }
});

const AuthToken = mongoose.model('AuthToken', authTokenSchema);

module.exports = AuthToken;
