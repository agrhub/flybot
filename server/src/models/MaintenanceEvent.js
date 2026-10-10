const mongoose = require('mongoose');

const MAINTENANCE_TYPES = ['card_replaced', 'lure_replaced', 'lens_cleaned', 'other'];

/**
 * Field work on a trap. A sticky card collects insects until it is replaced, so
 * "card_replaced" resets the count; the others are kept for the farm's records.
 * source "detected": recorded automatically when the count dropped sharply (see
 * services/maintenanceService.js); people can delete it if it was wrong.
 */
const maintenanceEventSchema = new mongoose.Schema({
    deviceSerial: { type: String, required: true },
    type: { type: String, enum: MAINTENANCE_TYPES, required: true },
    at: { type: Date, required: true },
    note: { type: String, default: '' },
    source: { type: String, enum: ['manual', 'detected'], default: 'manual' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    userEmail: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now }
});

maintenanceEventSchema.index({ deviceSerial: 1, at: -1 });
maintenanceEventSchema.index({ deviceSerial: 1, type: 1, at: -1 });

const MaintenanceEvent = mongoose.model('MaintenanceEvent', maintenanceEventSchema);

module.exports = MaintenanceEvent;
module.exports.MAINTENANCE_TYPES = MAINTENANCE_TYPES;
