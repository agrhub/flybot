const mongoose = require('mongoose');

/**
 * One signed-in device. The login token carries the session id ("sid"), so a session
 * can be listed and signed out individually.
 */
const sessionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    browser: { type: String, default: '' },
    os: { type: String, default: '' },
    ip: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: null },
    // Same lifetime as the login token; MongoDB removes the record afterwards
    expiresAt: { type: Date, required: true, index: { expires: 0 } }
});

const Session = mongoose.model('Session', sessionSchema);

module.exports = Session;
