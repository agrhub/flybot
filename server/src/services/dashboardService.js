const { Camera, User } = require('../models');
const { isAdmin, roleOf, canBuildDashboards } = require('../constants/roles');
const { viewFilter } = require('../utils/ownership');
const { thresholdOf, riskLevel } = require('../constants/risk');
const { latestProcessedByCamera } = require('./snapshotQueries');
const { countPests } = require('./notificationService');
const dailyStats = require('./dailyStats');
const catchStats = require('./catchStats');
const { trapKindOf } = require('../constants/trap');

/**
 * Dashboard access rules:
 *  - view: the owner, people it is shared with, and admins (public ones: anyone with the link)
 *  - past `expiresAt`, the public link and the people it is shared with lose access
 *  - edit: admins, and the owner while they may build dashboards (admin/manager)
 * Camera data shown on a dashboard is limited to:
 *  - public link:  cameras the owner owns (an admin owner: any camera)
 *  - signed in:    the above, plus cameras the viewer can see anyway
 * so sharing a dashboard never leaks a camera that was only shared with its owner.
 */
const idOf = (user) => String(user?.id ?? user?._id ?? '');
// ownerId may be populated
const ownerIdOf = (dashboard) => String(dashboard.ownerId?._id ?? dashboard.ownerId);

const isExpired = (dashboard, now = new Date()) => !!dashboard?.expiresAt && new Date(dashboard.expiresAt) <= now;

function dashboardViewFilter(user) {
    if (isAdmin(user)) return {};
    const id = idOf(user);
    if (!id) return { _id: null };
    const notExpired = { $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] };
    return { $or: [{ ownerId: id }, { $and: [{ 'sharedWith.userId': id }, notExpired] }] };
}

function canViewDashboard(user, dashboard) {
    if (!dashboard) return false;
    if (isAdmin(user)) return true;
    const id = idOf(user);
    if (ownerIdOf(dashboard) === id) return true;
    return !isExpired(dashboard) && (dashboard.sharedWith || []).some(sh => sh.userId && String(sh.userId) === id);
}

function canEditDashboard(user, dashboard) {
    if (!dashboard) return false;
    if (isAdmin(user)) return true;
    return canBuildDashboards(user) && ownerIdOf(dashboard) === idOf(user);
}

function accessOf(user, dashboard) {
    if (ownerIdOf(dashboard) === idOf(user)) return 'owner';
    if ((dashboard.sharedWith || []).some(sh => sh.userId && String(sh.userId) === idOf(user))) return 'shared';
    return 'admin';
}

/**
 * Serials (among `serials`) the owner may publish: their own cameras, or any camera for an admin.
 */
async function ownerPublishableSerials(owner, serials) {
    if (!owner || owner.disabled || !serials.length) return [];
    const filter = { deviceSerial: { $in: serials } };
    if (roleOf(owner) !== 'admin') filter.userId = owner._id;
    const cams = await Camera.find(filter).select('deviceSerial');
    return cams.map(c => c.deviceSerial);
}

/**
 * Cameras whose data this audience may see on the dashboard. `viewer` is null for the public link.
 */
async function effectiveSerials(dashboard, viewer) {
    const serials = dashboard.cameraSerials || [];
    if (!serials.length) return [];
    const owner = await User.findById(ownerIdOf(dashboard)).select('role disabled');
    const allowed = new Set(await ownerPublishableSerials(owner, serials));
    if (viewer) {
        const own = await Camera.find({ deviceSerial: { $in: serials }, ...viewFilter(viewer) }).select('deviceSerial');
        own.forEach(c => allowed.add(c.deviceSerial));
    }
    // Keep the dashboard's order
    return serials.filter(s => allowed.has(s));
}

// --- Time range ------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const PRESET_DAYS = { '7d': 7, '30d': 30, '3m': 90, '6m': 180, '12m': 365 };
const MAX_RANGE_DAYS = 366;
const DAY_KEY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
// Noon UTC is the same calendar day in the farm time zone (Asia/Ho_Chi_Minh, UTC+7)
const keyTime = (key) => new Date(`${key}T12:00:00Z`).getTime();
const isDayKey = (key) => typeof key === 'string' && DAY_KEY_REGEX.test(key) && !Number.isNaN(keyTime(key))
    && new Date(keyTime(key)).toISOString().slice(0, 10) === key;
const spanDays = (from, to) => Math.round((keyTime(to) - keyTime(from)) / DAY_MS) + 1;

/**
 * Check a range from a request body or query. Returns { range } or { error }.
 */
function parseRange(input) {
    const preset = input?.preset;
    if (PRESET_DAYS[preset]) return { range: { preset } };
    if (preset !== 'custom') return { error: "Invalid time range." };
    const { from, to } = input;
    if (!isDayKey(from) || !isDayKey(to) || from > to) return { error: "Invalid time range." };
    if (spanDays(from, to) > MAX_RANGE_DAYS) return { error: `A time range can cover at most ${MAX_RANGE_DAYS} days.` };
    return { range: { preset: 'custom', from, to } };
}

/**
 * The days a range covers: { preset, from, to, days, end }. `end` is the moment the data stops
 * (now, or the end of the last local day of a custom range in the past).
 */
function resolveRange(range, now = new Date()) {
    const today = dailyStats.dayKeyOf(now);
    if (range?.preset === 'custom' && isDayKey(range.from) && isDayKey(range.to)) {
        const to = range.to > today ? today : range.to;
        const from = range.from > to ? to : range.from;
        const days = Math.min(MAX_RANGE_DAYS, spanDays(from, to));
        const end = to === today ? now : new Date(`${to}T23:59:59.999+07:00`);
        return { preset: 'custom', from, to, days, end };
    }
    const preset = PRESET_DAYS[range?.preset] ? range.preset : '7d';
    const days = PRESET_DAYS[preset];
    return { preset, from: dailyStats.dayKeyOf(now.getTime() - (days - 1) * DAY_MS), to: today, days, end: now };
}

// --- Widget data -----------------------------------------------------------

// Hourly activity reads every photo: limit it to the last month of the range
const ACTIVITY_MAX_DAYS = 31;

// Latest processed snapshot per camera, with its pest count (one DISTINCT_SCAN query)
async function latestPerCamera(serials) {
    const latest = await latestProcessedByCamera(serials);
    for (const row of latest.values()) row.count = countPests(row.summary);
    return latest;
}

const round1 = (n) => Math.round(n * 10) / 10;

// Sum of the cameras' catches over some days; null when no camera has data on any of them
function sumOver(entries, days) {
    let total = null;
    for (const { total: byDay } of entries) {
        for (const day of days) {
            const v = byDay.get(day);
            if (v !== null && v !== undefined) total = (total || 0) + v;
        }
    }
    return total === null ? null : round1(total);
}

/**
 * Days grouped for charts and tables: by day up to two months, by week up to six, then by month.
 */
function bucketsOf(dayKeys) {
    const unit = dayKeys.length <= 62 ? 'day' : dayKeys.length <= 186 ? 'week' : 'month';
    const buckets = [];
    dayKeys.forEach((day, i) => {
        const key = unit === 'day' ? day : unit === 'week' ? String(Math.floor(i / 7)) : day.slice(0, 7);
        if (buckets.at(-1)?.key !== key) buckets.push({ key, from: day, to: day, days: [] });
        const bucket = buckets.at(-1);
        bucket.to = day;
        bucket.days.push(day);
    });
    return { unit, buckets };
}

function speciesTotals(entries, days) {
    const totals = new Map();
    for (const { species } of entries) {
        for (const [name, byDay] of species) {
            for (const day of days) {
                const v = byDay.get(day);
                if (v) totals.set(name, (totals.get(name) || 0) + v);
            }
        }
    }
    return [...totals.entries()]
        .map(([label, value]) => ({ label, value: round1(value) }))
        .filter(sp => sp.value > 0)
        .sort((a, b) => b.value - a.value);
}

function kpiData(cameras, entries, ctx, latest) {
    const current = catchStats.summarize(entries, ctx.current);
    const previous = catchStats.summarize(entries, ctx.previous);
    const serials = new Set(cameras.map(c => c.deviceSerial));
    return {
        cameras: cameras.length,
        online: cameras.filter(c => c.status === 1).length,
        alertCameras: cameras.filter(c => (latest.get(c.deviceSerial)?.count || 0) >= thresholdOf(c)).length,
        scans: ctx.rows.filter(r => serials.has(r.deviceSerial)).reduce((sum, r) => sum + r.scans, 0),
        catches: round1(current.total),
        ftd: current.ftd,
        avgPerDay: current.avgPerDay,
        busiestDay: current.maxDay ? { day: current.maxDay.day, value: round1(current.maxDay.value) } : null,
        previousCatches: previous.trapDays ? round1(previous.total) : null,
        previousFtd: previous.ftd,
        changePct: current.trapDays && previous.trapDays ? catchStats.percentChange(current.total, previous.total) : null
    };
}

function trendData(entries, ctx) {
    return {
        points: ctx.current.map((day, i) => ({
            date: day,
            value: sumOver(entries, [day]),
            previous: ctx.previous[i] ? sumOver(entries, [ctx.previous[i]]) : null
        }))
    };
}

function catchesByTrapData(cameras, ctx) {
    const { unit, buckets } = bucketsOf(ctx.current);
    return {
        unit,
        labels: buckets.map(b => b.from),
        series: cameras.map(c => {
            const entry = ctx.cameras.get(c.deviceSerial);
            return {
                deviceSerial: c.deviceSerial,
                deviceName: c.deviceName,
                data: buckets.map(b => (entry ? sumOver([entry], b.days) : null))
            };
        })
    };
}

function cameraRankingData(cameras, ctx, latest) {
    const ranking = cameras.map(c => {
        const entry = ctx.cameras.get(c.deviceSerial);
        const one = entry ? [entry] : [];
        const current = catchStats.summarize(one, ctx.current);
        const previous = catchStats.summarize(one, ctx.previous);
        const latestCount = latest.get(c.deviceSerial)?.count || 0;
        const threshold = thresholdOf(c);
        return {
            deviceSerial: c.deviceSerial,
            deviceName: c.deviceName,
            trapKind: trapKindOf(c),
            total: round1(current.total),
            ftd: current.ftd,
            busiestDay: current.maxDay ? { day: current.maxDay.day, value: round1(current.maxDay.value) } : null,
            daysWithData: current.trapDays,
            changePct: current.trapDays && previous.trapDays ? catchStats.percentChange(current.total, previous.total) : null,
            latestCount,
            threshold,
            risk: riskLevel(latestCount, threshold)
        };
    });
    ranking.sort((a, b) => (b.ftd ?? -1) - (a.ftd ?? -1) || b.total - a.total || b.latestCount - a.latestCount);
    return { cameras: ranking };
}

function dailyTableData(entries, ctx) {
    const { unit, buckets } = bucketsOf(ctx.current);
    const rows = buckets.map(b => {
        const summary = catchStats.summarize(entries, b.days);
        return {
            from: b.from,
            to: b.to,
            total: summary.trapDays ? round1(summary.total) : null,
            ftd: summary.ftd,
            trapDays: summary.trapDays,
            topSpecies: speciesTotals(entries, b.days)[0] || null
        };
    });
    return { unit, rows: rows.reverse() };
}

async function activityData(serials, range) {
    const days = Math.min(range.days, ACTIVITY_MAX_DAYS);
    return { ...(await catchStats.activityByHour(serials, days, range.end)), windowDays: days };
}

async function latestSnapshotData(cameras, latest, imageUrl) {
    return {
        snapshots: cameras.map(c => {
            const snap = latest.get(c.deviceSerial);
            const count = snap?.count || 0;
            return {
                deviceSerial: c.deviceSerial,
                deviceName: c.deviceName,
                status: c.status,
                createdAt: snap?.createdAt || null,
                count,
                risk: riskLevel(count, thresholdOf(c)),
                imageUrl: snap?.s3Key ? imageUrl(snap.s3Key) : null
            };
        })
    };
}

const CATCH_WIDGETS = ['kpi', 'trend', 'catchesByTrap', 'species', 'cameraRanking', 'dailyTable'];
const LATEST_WIDGETS = ['kpi', 'cameraRanking', 'latestSnapshot'];

/**
 * Data for every widget, keyed by widget id, over the report's time range (or `range` when the
 * viewer picked another one). `serials` are the cameras this audience may see;
 * `imageUrl(s3Key)` builds the image link (signed-in proxy or public-link proxy).
 * Returns { range, widgets }.
 */
async function computeWidgetData(dashboard, serials, { imageUrl, range: wanted = null, now = new Date() }) {
    const range = resolveRange(wanted || dashboard.range, now);
    const widgets = dashboard.widgets || [];
    const cameras = serials.length
        ? await Camera.find({ deviceSerial: { $in: serials } }).select('deviceSerial deviceName status alertThreshold trapKind')
        : [];
    const cameraBySerial = new Map(cameras.map(c => [c.deviceSerial, c]));
    const allowed = new Set(serials);
    const uses = (types) => widgets.some(w => types.includes(w.type));

    // Catches of the range and of the period before it ("compared with before"), read once for all widgets
    const ctx = { cameras: new Map(), current: [], previous: [], rows: [] };
    if (serials.length && uses(CATCH_WIDGETS)) {
        const { dayKeys, cameras: byCamera } = await catchStats.catchesBySerial(serials, range.days * 2, range.end);
        ctx.cameras = byCamera;
        ctx.current = dayKeys.slice(-range.days);
        ctx.previous = dayKeys.slice(0, dayKeys.length - range.days);
        if (uses(['kpi'])) ctx.rows = await dailyStats.rows(serials, ctx.current[0], ctx.current.at(-1));
    }
    const latest = uses(LATEST_WIDGETS) ? await latestPerCamera(serials) : new Map();

    const entries = await Promise.all(widgets.map(async (widget) => {
        const scoped = widget.cameraSerials?.length ? widget.cameraSerials.filter(s => allowed.has(s)) : serials;
        const scopedCameras = scoped.map(s => cameraBySerial.get(s)).filter(Boolean);
        const catches = scoped.map(s => ctx.cameras.get(s)).filter(Boolean);
        let data;
        switch (widget.type) {
            case 'kpi': data = kpiData(scopedCameras, catches, ctx, latest); break;
            case 'trend': data = trendData(catches, ctx); break;
            case 'catchesByTrap': data = catchesByTrapData(scopedCameras, ctx); break;
            case 'species': data = { species: speciesTotals(catches, ctx.current) }; break;
            case 'cameraRanking': data = cameraRankingData(scopedCameras, ctx, latest); break;
            case 'dailyTable': data = dailyTableData(catches, ctx); break;
            case 'activity': data = scoped.length ? await activityData(scoped, range) : null; break;
            case 'latestSnapshot': data = await latestSnapshotData(scopedCameras, latest, imageUrl); break;
            default: data = null;
        }
        return [widget.id, data];
    }));
    return {
        range: { preset: range.preset, from: range.from, to: range.to, days: range.days },
        widgets: Object.fromEntries(entries)
    };
}

module.exports = {
    isExpired,
    dashboardViewFilter,
    canViewDashboard,
    canEditDashboard,
    accessOf,
    ownerPublishableSerials,
    effectiveSerials,
    parseRange,
    resolveRange,
    computeWidgetData
};
