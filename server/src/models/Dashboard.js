const mongoose = require('mongoose');

const WIDGET_TYPES = ['kpi', 'trend', 'species', 'cameraRanking', 'latestSnapshot'];

const widgetSchema = new mongoose.Schema({
    id: { type: String, required: true },
    type: { type: String, enum: WIDGET_TYPES, required: true },
    title: { type: String, default: '' },
    // Subset of the dashboard cameras; empty = all of them
    cameraSerials: { type: [String], default: [] },
    // Look-back window for the widget's data
    rangeDays: { type: Number, default: 7, min: 1, max: 365 },
    // Grid position (24-column grid)
    layout: {
        x: { type: Number, default: 0 },
        y: { type: Number, default: 0 },
        w: { type: Number, default: 12 },
        h: { type: Number, default: 4 }
    }
}, { _id: false });

/**
 * Same shape as a camera share: `userId` is null for an invitation to an email
 * that has no account yet, filled in once that person verifies the address.
 */
const dashboardShareSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    email: { type: String, required: true, lowercase: true, trim: true },
    sharedAt: { type: Date, default: Date.now }
}, { _id: false });

const dashboardSchema = new mongoose.Schema({
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    // Cameras the dashboard reads from
    cameraSerials: { type: [String], default: [] },
    widgets: { type: [widgetSchema], default: [] },
    // public = anyone with the link (read-only, no sign-in)
    visibility: { type: String, enum: ['private', 'public'], default: 'private' },
    publicToken: { type: String, default: undefined },
    sharedWith: { type: [dashboardShareSchema], default: [] }
}, { timestamps: true });

dashboardSchema.index({ publicToken: 1 }, { unique: true, sparse: true });
dashboardSchema.index({ 'sharedWith.userId': 1 });
dashboardSchema.index({ 'sharedWith.email': 1 });

const Dashboard = mongoose.model('Dashboard', dashboardSchema);

module.exports = Dashboard;
module.exports.WIDGET_TYPES = WIDGET_TYPES;
