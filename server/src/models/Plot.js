const mongoose = require('mongoose');

/**
 * A plot (lô) of a farm. Cameras point at their plot with Camera.plotId / Camera.farmId.
 * boundary: polygon vertices as [lat, lng] pairs (drawn on the map), or empty.
 */
const plotSchema = new mongoose.Schema({
    // Simulated demo data (scripts/demo_sim.js): labeled wherever it is shown, never mixed with real data
    simulated: { type: Boolean, default: undefined },
    // The simulated plot's stable key (services/demoSimWorld.js)
    simKey: { type: String, default: undefined },
    farmId: { type: mongoose.Schema.Types.ObjectId, ref: 'Farm', required: true, index: true },
    name: { type: String, required: true, trim: true },
    crop: { type: String, default: '' },
    areaHa: { type: Number, default: null, min: 0 },
    color: { type: String, default: '#3ecf8e' },
    // Alert when the average latest count of the plot's traps reaches this (null = off)
    alertThreshold: { type: Number, default: null, min: 1 },
    boundary: { type: [[Number]], default: [] }
}, { timestamps: true });

const Plot = mongoose.model('Plot', plotSchema);

module.exports = Plot;
