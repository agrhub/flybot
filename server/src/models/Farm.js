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
    // Simulated demo data (scripts/demo_sim.js): labeled wherever it is shown, never mixed with real data
    simulated: { type: Boolean, default: undefined },
    // The simulated farm's stable key (services/demoSimWorld.js), so its names can change in place
    simKey: { type: String, default: undefined },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    // IANA timezone of the farm ('' = not set): the clock of its CamOS cameras (GET /api/device/time, shadow tz)
    timezone: { type: String, default: '' },
    sharedWith: { type: [farmShareSchema], default: [] },
    // Members of the organization see the farm; its owners/managers edit it
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true }
}, { timestamps: true });

farmSchema.index({ 'sharedWith.userId': 1 });
farmSchema.index({ 'sharedWith.email': 1 });

const Farm = mongoose.model('Farm', farmSchema);

module.exports = Farm;
