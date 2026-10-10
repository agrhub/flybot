const mongoose = require('mongoose');

/**
 * A farm groups plots (and through them, cameras). Sharing a farm by email gives
 * view access to every camera in its plots (services/farmService.js keeps the cameras'
 * share lists in step, marked with viaFarm).
 */
const farmShareSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    email: { type: String, required: true, lowercase: true, trim: true },
    sharedAt: { type: Date, default: Date.now }
}, { _id: false });

const farmSchema = new mongoose.Schema({
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    sharedWith: { type: [farmShareSchema], default: [] }
}, { timestamps: true });

farmSchema.index({ 'sharedWith.userId': 1 });
farmSchema.index({ 'sharedWith.email': 1 });

const Farm = mongoose.model('Farm', farmSchema);

module.exports = Farm;
