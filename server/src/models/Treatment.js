const mongoose = require('mongoose');

const TREATMENT_TYPES = ['spray', 'bait', 'lure', 'biological', 'sanitation', 'bagging', 'other'];

/**
 * A pest-control treatment (IPM log): what was applied where, by whom and when.
 * Kept as the farm's pesticide-use record (VietGAP / GlobalGAP) and used to judge
 * whether catches went down afterwards (services/treatmentService.js).
 */
const treatmentSchema = new mongoose.Schema({
    // Traps in the treated area (the effect is measured on these)
    cameraSerials: { type: [String], required: true },
    type: { type: String, enum: TREATMENT_TYPES, required: true },
    at: { type: Date, required: true },
    product: { type: String, default: '' },
    activeIngredient: { type: String, default: '' },
    dose: { type: String, default: '' },
    area: { type: String, default: '' },
    operator: { type: String, default: '' },
    // Pre-harvest interval in days (no harvest before at + preHarvestDays)
    preHarvestDays: { type: Number, default: null, min: 0, max: 365 },
    note: { type: String, default: '' },
    // Set by the app for a treatment saved offline and sent later (utils/clientId.js)
    clientId: { type: String, default: undefined },
    // When the "harvest allowed again" reminder went out (services/harvestService.js)
    harvestNotifiedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByEmail: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

treatmentSchema.index({ cameraSerials: 1, at: -1 });
treatmentSchema.index({ at: -1 });
// One record per id the app gave it, per person
treatmentSchema.index({ createdBy: 1, clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } });

const Treatment = mongoose.model('Treatment', treatmentSchema);

module.exports = Treatment;
module.exports.TREATMENT_TYPES = TREATMENT_TYPES;
