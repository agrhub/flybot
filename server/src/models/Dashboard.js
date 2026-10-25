const mongoose = require('mongoose');

const WIDGET_TYPES = ['kpi', 'trend', 'catchesByTrap', 'species', 'cameraRanking', 'dailyTable', 'activity', 'latestSnapshot'];
// Report time ranges: last 7 or 30 days, 3, 6 or 12 months, or chosen dates
const RANGE_PRESETS = ['7d', '30d', '3m', '6m', '12m', 'custom'];
const GRANULARITIES = ['auto', 'day', 'week', 'month'];
const CAMERA_STATUSES = ['all', 'online', 'offline'];
const RISK_FILTERS = ['all', 'high', 'moderate', 'low'];
const SCHEDULE_FREQUENCIES = ['off', 'weekly', 'monthly'];
const SCHEDULE_RECIPIENTS = ['owner', 'all'];

const widgetSchema = new mongoose.Schema({
    id: { type: String, required: true },
    type: { type: String, enum: WIDGET_TYPES, required: true },
    title: { type: String, default: '' },
    // Subset of the dashboard cameras; empty = all of them
    cameraSerials: { type: [String], default: [] },
    // Unused since reports have one time range; kept so older documents still validate
    rangeDays: { type: Number, default: 7, min: 1, max: 365 },
    // The widget's own filters. No range preset = the report's range.
    range: {
        preset: { type: String, enum: RANGE_PRESETS, default: undefined },
        from: { type: String, default: undefined },
        to: { type: String, default: undefined }
    },
    // Days grouped by day, week or month; auto picks from the length of the range
    granularity: { type: String, enum: GRANULARITIES, default: 'auto' },
    // Only cameras online/offline, and only cameras whose count now is in a risk level
    status: { type: String, enum: CAMERA_STATUSES, default: 'all' },
    risk: { type: String, enum: RISK_FILTERS, default: 'all' },
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
    sharedAt: { type: Date, default: Date.now },
    // This person stopped the report's scheduled emails and Telegram messages for themselves
    scheduleMuted: { type: Boolean, default: false }
}, { _id: false });

const dashboardSchema = new mongoose.Schema({
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // The workspace it belongs to (null = made before workspaces: the owner's personal one)
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    // Cameras the dashboard reads from
    cameraSerials: { type: [String], default: [] },
    widgets: { type: [widgetSchema], default: [] },
    // public = anyone with the link (read-only, no sign-in)
    visibility: { type: String, enum: ['private', 'public'], default: 'private' },
    publicToken: { type: String, default: undefined },
    sharedWith: { type: [dashboardShareSchema], default: [] },
    // A sample report of the simulated demo farm (services/demoSim.js ensureReports), by its stable key
    simKey: { type: String, default: undefined },
    // A report a visitor made on the shared guest account (services/guestAccess.js): only that guest
    // session sees and changes it, and it is removed when the session ends
    guestSession: { type: String, default: undefined, index: true },
    // Default time range of the report; viewers can pick another one
    range: {
        preset: { type: String, enum: RANGE_PRESETS, default: '7d' },
        // Local day keys (YYYY-MM-DD) for a custom range
        from: { type: String, default: undefined },
        to: { type: String, default: undefined }
    },
    // After this moment the public link and the people it is shared with lose access (null = never)
    expiresAt: { type: Date, default: null },
    // Emailed with a PDF on a schedule, farm time (services/reportScheduleService.js)
    schedule: {
        frequency: { type: String, enum: SCHEDULE_FREQUENCIES, default: 'off' },
        // Monday = 1 ... Sunday = 7
        weekday: { type: Number, min: 1, max: 7, default: 1 },
        monthDay: { type: Number, min: 1, max: 28, default: 1 },
        hour: { type: Number, min: 0, max: 23, default: 7 },
        // owner only, or also the people it is shared with
        recipients: { type: String, enum: SCHEDULE_RECIPIENTS, default: 'owner' },
        lastSentAt: { type: Date, default: null }
    }
}, { timestamps: true });

dashboardSchema.index({ publicToken: 1 }, { unique: true, sparse: true });
dashboardSchema.index({ 'sharedWith.userId': 1 });
dashboardSchema.index({ 'sharedWith.email': 1 });
dashboardSchema.index({ 'schedule.frequency': 1 });

const Dashboard = mongoose.model('Dashboard', dashboardSchema);

module.exports = Dashboard;
module.exports.WIDGET_TYPES = WIDGET_TYPES;
module.exports.RANGE_PRESETS = RANGE_PRESETS;
module.exports.GRANULARITIES = GRANULARITIES;
module.exports.CAMERA_STATUSES = CAMERA_STATUSES;
module.exports.RISK_FILTERS = RISK_FILTERS;
module.exports.SCHEDULE_FREQUENCIES = SCHEDULE_FREQUENCIES;
module.exports.SCHEDULE_RECIPIENTS = SCHEDULE_RECIPIENTS;
