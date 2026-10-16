const { Camera, User } = require('../models');
const { isAdmin, roleOf } = require('../constants/roles');
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
    const base = { $or: [{ ownerId: id }, { $and: [{ 'sharedWith.userId': id }, notExpired] }] };
    // More than one workspace: the current one's dashboards (and, in the personal one, those shared with the person)
    const scope = require('./workspaceService').scopeFilter(user, { ownerField: 'ownerId' });
    return scope ? { $and: [base, scope] } : base;
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
    return ownerIdOf(dashboard) === idOf(user);
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

/**
 * The count each camera is compared with its threshold by, as the threshold alert does:
 * the latest photo on a sticky trap, the day's average per photo on a lure trap.
 * Returns Map(serial -> { value, basis: 'latest' | 'dailyAverage' }).
 */
async function judgedCounts(cameras, latest, now = new Date()) {
    const lure = cameras.filter(c => trapKindOf(c) === 'lure').map(c => c.deviceSerial);
    const today = dailyStats.dayKeyOf(now);
    const rows = lure.length ? await dailyStats.rows(lure, today, today) : [];
    const average = new Map(rows.filter(r => r.scans).map(r => [r.deviceSerial, round1(r.total / r.scans)]));
    return new Map(cameras.map(c => [c.deviceSerial, trapKindOf(c) === 'lure'
        ? { value: average.get(c.deviceSerial) ?? 0, basis: 'dailyAverage' }
        : { value: latest.get(c.deviceSerial)?.count || 0, basis: 'latest' }]));
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
 * Days grouped for charts and tables. "auto": by day up to two months, by week up to six, then by month.
 */
function bucketsOf(dayKeys, granularity = 'auto') {
    const unit = ['day', 'week', 'month'].includes(granularity)
        ? granularity
        : dayKeys.length <= 62 ? 'day' : dayKeys.length <= 186 ? 'week' : 'month';
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

function kpiData(cameras, entries, ctx, judged) {
    const current = catchStats.summarize(entries, ctx.current);
    const previous = catchStats.summarize(entries, ctx.previous);
    const serials = new Set(cameras.map(c => c.deviceSerial));
    return {
        cameras: cameras.length,
        online: cameras.filter(c => c.status === 1).length,
        alertCameras: cameras.filter(c => (judged.get(c.deviceSerial)?.value || 0) >= thresholdOf(c)).length,
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

// Daily by default; grouped by week or month when the widget asks for it
function trendData(entries, ctx, granularity = 'day') {
    const unit = granularity === 'auto' ? 'day' : granularity;
    const current = bucketsOf(ctx.current, unit).buckets;
    const previous = bucketsOf(ctx.previous, unit).buckets;
    // Line up the period before from its end, so the last points compare like for like
    const offset = previous.length - current.length;
    return {
        unit,
        points: current.map((b, i) => ({
            date: b.from,
            to: b.to,
            value: sumOver(entries, b.days),
            previous: previous[i + offset] ? sumOver(entries, previous[i + offset].days) : null
        }))
    };
}

function catchesByTrapData(cameras, ctx, granularity = 'auto') {
    const { unit, buckets } = bucketsOf(ctx.current, granularity);
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

function cameraRankingData(cameras, ctx, latest, judged) {
    const ranking = cameras.map(c => {
        const entry = ctx.cameras.get(c.deviceSerial);
        const one = entry ? [entry] : [];
        const current = catchStats.summarize(one, ctx.current);
        const previous = catchStats.summarize(one, ctx.previous);
        const latestCount = latest.get(c.deviceSerial)?.count || 0;
        const threshold = thresholdOf(c);
        const { value, basis } = judged.get(c.deviceSerial) || { value: latestCount, basis: 'latest' };
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
            // What the threshold is compared with (the day's average on a lure trap)
            riskValue: value,
            riskBasis: basis,
            threshold,
            risk: riskLevel(value, threshold)
        };
    });
    ranking.sort((a, b) => (b.ftd ?? -1) - (a.ftd ?? -1) || b.total - a.total || b.latestCount - a.latestCount);
    return { cameras: ranking };
}

function dailyTableData(entries, ctx, granularity = 'auto') {
    const { unit, buckets } = bucketsOf(ctx.current, granularity);
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

async function latestSnapshotData(cameras, latest, judged, imageUrl) {
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
                risk: riskLevel(judged.get(c.deviceSerial)?.value ?? count, thresholdOf(c)),
                imageUrl: snap?.s3Key ? imageUrl(snap.s3Key) : null
            };
        })
    };
}

const CATCH_WIDGETS = ['kpi', 'trend', 'catchesByTrap', 'species', 'cameraRanking', 'dailyTable'];
const LATEST_WIDGETS = ['kpi', 'cameraRanking', 'latestSnapshot'];

const rangeKey = (range) => `${range.preset}:${range.from}:${range.to}`;

/**
 * Data for every widget, keyed by widget id. A widget uses its own range when it has one, else the
 * report's range (or `range` when the viewer picked another one); its status and risk filters
 * narrow its cameras. `serials` are the cameras this audience may see; `imageUrl(s3Key)` builds
 * the image link (signed-in proxy or public-link proxy).
 * Returns { range, widgets }; each widget's data carries the range it covers.
 */
async function computeWidgetData(dashboard, serials, { imageUrl, range: wanted = null, now = new Date() }) {
    const range = resolveRange(wanted || dashboard.range, now);
    const widgets = dashboard.widgets || [];
    const cameras = serials.length
        ? await Camera.find({ deviceSerial: { $in: serials } }).select('deviceSerial deviceName status alertThreshold trapKind')
        : [];
    const cameraBySerial = new Map(cameras.map(c => [c.deviceSerial, c]));
    const allowed = new Set(serials);
    const needsLatest = widgets.some(w => LATEST_WIDGETS.includes(w.type) || (w.risk && w.risk !== 'all'));
    const latest = needsLatest ? await latestPerCamera(serials) : new Map();
    const judged = needsLatest ? await judgedCounts(cameras, latest, now) : new Map();

    // Catches of a range and of the period before it ("compared with before"), read once per range
    const contexts = new Map();
    const contextOf = (widgetRange) => {
        const key = rangeKey(widgetRange);
        if (!contexts.has(key)) {
            contexts.set(key, (async () => {
                const ctx = { cameras: new Map(), current: [], previous: [], rows: [] };
                if (!serials.length) return ctx;
                const { dayKeys, cameras: byCamera } = await catchStats.catchesBySerial(serials, widgetRange.days * 2, widgetRange.end);
                ctx.cameras = byCamera;
                ctx.current = dayKeys.slice(-widgetRange.days);
                ctx.previous = dayKeys.slice(0, dayKeys.length - widgetRange.days);
                ctx.rows = await dailyStats.rows(serials, ctx.current[0], ctx.current.at(-1));
                return ctx;
            })());
        }
        return contexts.get(key);
    };

    const entries = await Promise.all(widgets.map(async (widget) => {
        const widgetRange = widget.range?.preset ? resolveRange(widget.range, now) : range;
        const status = widget.status || 'all';
        const risk = widget.risk || 'all';
        const scoped = (widget.cameraSerials?.length ? widget.cameraSerials.filter(s => allowed.has(s)) : serials)
            .filter((serial) => {
                const camera = cameraBySerial.get(serial);
                if (status === 'online' && camera?.status !== 1) return false;
                if (status === 'offline' && camera?.status === 1) return false;
                if (risk !== 'all' && riskLevel(judged.get(serial)?.value || 0, thresholdOf(camera)) !== risk) return false;
                return true;
            });
        const scopedCameras = scoped.map(s => cameraBySerial.get(s)).filter(Boolean);
        const ctx = CATCH_WIDGETS.includes(widget.type) ? await contextOf(widgetRange) : null;
        const catches = ctx ? scoped.map(s => ctx.cameras.get(s)).filter(Boolean) : [];
        const granularity = widget.granularity || 'auto';
        let data;
        switch (widget.type) {
            case 'kpi': data = kpiData(scopedCameras, catches, ctx, judged); break;
            case 'trend': data = trendData(catches, ctx, granularity); break;
            case 'catchesByTrap': data = catchesByTrapData(scopedCameras, ctx, granularity); break;
            case 'species': data = { species: speciesTotals(catches, ctx.current) }; break;
            case 'cameraRanking': data = cameraRankingData(scopedCameras, ctx, latest, judged); break;
            case 'dailyTable': data = dailyTableData(catches, ctx, granularity); break;
            case 'activity': data = scoped.length ? await activityData(scoped, widgetRange) : null; break;
            case 'latestSnapshot': data = await latestSnapshotData(scopedCameras, latest, judged, imageUrl); break;
            default: data = null;
        }
        if (data) data.range = { preset: widgetRange.preset, from: widgetRange.from, to: widgetRange.to, days: widgetRange.days, own: !!widget.range?.preset };
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
    judgedCounts,
    computeWidgetData
};
