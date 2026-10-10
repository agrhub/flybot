const mongoose = require('mongoose');

/**
 * A key for the public read-only API (/api/v1). Only a SHA-256 hash of the key is stored;
 * the key itself is shown once when created.
 */
const apiKeySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    // First characters of the key, to tell keys apart in the list
    prefix: { type: String, required: true },
    hash: { type: String, required: true, unique: true },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null }
}, { timestamps: true });

const ApiKey = mongoose.model('ApiKey', apiKeySchema);

module.exports = ApiKey;
