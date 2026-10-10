const mongoose = require('mongoose');

/**
 * One camera's AI-processed scans for one local day (services/dailyStats.js keeps it up to date).
 * Statistics over days, weeks and months read these instead of millions of snapshots.
 *  - total/peak/min: pest counts per scan (non-pest labels such as people excluded)
 *  - species: per species, the highest count in one scan (peak) and the sum over scans (total)
 */
const speciesSchema = new mongoose.Schema({
    name: { type: String, required: true },
    peak: { type: Number, default: 0 },
    total: { type: Number, default: 0 }
}, { _id: false });

const dailyStatSchema = new mongoose.Schema({
    deviceSerial: { type: String, required: true },
    // Local calendar day (captureSchedule.TIMEZONE), "YYYY-MM-DD": sorts and compares as text
    day: { type: String, required: true },
    scans: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    peak: { type: Number, default: 0 },
    min: { type: Number, default: 0 },
    species: { type: [speciesSchema], default: [] },
    updatedAt: { type: Date, default: Date.now }
});

dailyStatSchema.index({ deviceSerial: 1, day: 1 }, { unique: true });
// Retention cleanup and cross-camera ranges
dailyStatSchema.index({ day: 1 });

const DailyStat = mongoose.model('DailyStat', dailyStatSchema);

module.exports = DailyStat;
