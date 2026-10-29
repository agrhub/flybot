const mongoose = require('mongoose');

const RETENTION_DAYS = 60;

/**
 * One battery reading of a CamOS camera between its photos (MQTT state, telemetry and events that carry the battery
 * block; camos-esp32-trap battery.c), for the power charts (services/powerHistory.js). The photos keep their own
 * reading in Snapshot.meta.battery. Kept 60 days.
 */
const powerReadingSchema = new mongoose.Schema({
    deviceSerial: { type: String, required: true },
    // When the camera read it (its message time `ts`, or when FlyBot got the message)
    at: { type: Date, required: true },
    mv: { type: Number, required: true }, // the cell, without the charger's lift (firmware 0.9.3-rc.3+)
    pct: { type: Number, default: undefined },
    charging: { type: Boolean, default: undefined },
    charge: { type: String, enum: ['normal', 'slow', 'none'], default: undefined },
    solarMv: { type: Number, default: undefined }, // the panel / charger input
    measuredMv: { type: Number, default: undefined }, // the reading itself while a charger lifts it
    source: { type: String, enum: ['state', 'telemetry', 'event'], default: 'telemetry' }
}, { versionKey: false });

// The same message twice (a retained state sent again) is stored once
powerReadingSchema.index({ deviceSerial: 1, at: 1 }, { unique: true });
powerReadingSchema.index({ at: 1 }, { expireAfterSeconds: RETENTION_DAYS * 24 * 60 * 60 });

const PowerReading = mongoose.model('PowerReading', powerReadingSchema);

module.exports = PowerReading;
module.exports.RETENTION_DAYS = RETENTION_DAYS;
