const mongoose = require('mongoose');
const { Dashboard, Notification, Treatment, User } = require('../../models');
const { viewableCameras } = require('../../utils/ownership');
const { isAdmin } = require('../../constants/roles');
const catchStats = require('../../services/catchStats');
const dashboardService = require('../../services/dashboardService');
const treatmentService = require('../../services/treatmentService');
const { cardDueAt } = require('../../services/maintenanceService');

const DAY_MS = 24 * 60 * 60 * 1000;
const round1 = (n) => Math.round(n * 10) / 10;

async function visibleCameras(user) {
    const cams = await viewableCameras(user).select('deviceSerial deviceName trapKind cardReplacedAt cardReminderDays addedAt status').lean();
    return [...new Map(cams.map(c => [c.deviceSerial, c])).values()];
}

// ---------- Reports ----------

const listReportsDeclaration = {
    name: 'list_reports',
    description: 'List the reports (custom dashboards) the user can open: id, name, default time range, schedule, whether it is shared.',
    parameters: { type: 'OBJECT', properties: {} }
};

async function executeListReports({ userId, user }) {
    if (!userId) return { error: 'Not authenticated.' };
    const reports = await Dashboard.find(dashboardService.dashboardViewFilter(user))
        .sort({ updatedAt: -1 }).limit(30)
        .select('name description range schedule visibility ownerId sharedWith expiresAt').lean();
    return {
        total: reports.length,
        reports: reports.map(r => ({
            id: String(r._id),
            name: r.name,
            description: r.description || '',
            range: r.range?.preset || '7d',
            schedule: r.schedule?.frequency && r.schedule.frequency !== 'off' ? r.schedule.frequency : 'off',
            mine: String(r.ownerId) === String(userId),
            publicLink: r.visibility === 'public'
        }))
    };
}

async function findReport(user, reportId) {
    if (!mongoose.isValidObjectId(reportId)) return null;
    const dashboard = await Dashboard.findById(reportId).populate('ownerId', 'email name role disabled');
    return dashboardService.canViewDashboard(user, dashboard) ? dashboard : null;
}

const getReportSummaryDeclaration = {
    name: 'get_report_summary',
    description: 'Key figures of one report over its time range (or the one given): insects caught, flies per trap per day, change vs the period before, traps over their threshold, and the traps with the most catches. Use the id from list_reports.',
    parameters: {
        type: 'OBJECT',
        properties: {
            reportId: { type: 'STRING', description: 'Report id from list_reports' },
            range: { type: 'STRING', enum: ['7d', '30d', '3m', '6m', '12m'], description: 'Time range (optional; default: the report\'s own)' }
        },
        required: ['reportId']
    }
};

async function executeGetReportSummary({ reportId, range, userId, user }) {
    if (!userId) return { error: 'Not authenticated.' };
    const dashboard = await findReport(user, String(reportId || ''));
    if (!dashboard) return { error: 'Report not found.' };
    const serials = await dashboardService.effectiveSerials(dashboard, user);
    // The figures every report can give, whatever blocks it shows
    const figures = { range: dashboard.range, widgets: [{ id: 'kpi', type: 'kpi' }, { id: 'ranking', type: 'cameraRanking' }] };
    const wanted = range ? dashboardService.parseRange({ preset: range }).range : null;
    const { range: covered, widgets } = await dashboardService.computeWidgetData(figures, serials, { imageUrl: () => '', range: wanted });
    const k = widgets.kpi || {};
    return {
        id: String(dashboard._id),
        name: dashboard.name,
        from: covered.from,
        to: covered.to,
        cameras: k.cameras,
        insectsCaught: k.catches,
        fliesPerTrapPerDay: k.ftd,
        changeVsPreviousPeriodPct: k.changePct,
        busiestDay: k.busiestDay,
        trapsOverThreshold: k.alertCameras,
        topTraps: (widgets.ranking?.cameras || []).slice(0, 5).map(c => ({ name: c.deviceName || c.deviceSerial, caught: c.total, ftd: c.ftd, risk: c.risk }))
    };
}

const sendReportDeclaration = {
    name: 'send_report_to_me',
    description: 'Email one report, with its PDF, to the user\'s own confirmed address. Only when the user asks for it.',
    parameters: {
        type: 'OBJECT',
        properties: {
            reportId: { type: 'STRING', description: 'Report id from list_reports' }
        },
        required: ['reportId']
    }
};

async function executeSendReport({ reportId, userId, user, addAction }) {
    if (!userId) return { error: 'Not authenticated.' };
    const dashboard = await findReport(user, String(reportId || ''));
    if (!dashboard) return { error: 'Report not found.' };
    const account = await User.findById(userId).select('email name language role disabled emailVerified');
    if (!account?.emailVerified) return { error: 'The user has to confirm their email address first (Settings > Profile).' };
    // Same quota as the "Email me" button
    const { reportSendQuota } = require('../../middlewares/rateLimit');
    if (!reportSendQuota.take(String(userId))) return { error: 'Reports were emailed several times in the last hour. Please try again later.' };
    await require('../../services/reportScheduleService').sendReportTo(dashboard, account, {});
    addAction('REPORT_SENT', { reportId: String(dashboard._id) });
    return { success: true, message: `Report "${dashboard.name}" is on its way to ${account.email}.` };
}

// ---------- Alerts and trap cards ----------

const getAlertsDeclaration = {
    name: 'get_alerts',
    description: 'Recent alerts the user received (threshold reached, sudden surge, camera offline, AI failing, photo quality, card due...) and the sticky trap cards due for replacement now.',
    parameters: {
        type: 'OBJECT',
        properties: {
            days: { type: 'NUMBER', description: 'How many days back (default 3, at most 30)' }
        }
    }
};

async function executeGetAlerts({ days = 3, userId, user }) {
    if (!userId) return { error: 'Not authenticated.' };
    const span = Math.max(1, Math.min(Number(days) || 3, 30));
    const [alerts, cameras] = await Promise.all([
        Notification.find({ userId, createdAt: { $gte: new Date(Date.now() - span * DAY_MS) } })
            .sort({ createdAt: -1 }).limit(30).select('type severity deviceSerial params read createdAt').lean(),
        visibleCameras(user)
    ]);
    const names = new Map(cameras.map(c => [c.deviceSerial, c.deviceName || c.deviceSerial]));
    const now = Date.now();
    const cardsDue = cameras
        .map(c => ({ c, due: cardDueAt(c) }))
        .filter(({ due }) => due && due.getTime() <= now)
        .map(({ c, due }) => ({ trap: names.get(c.deviceSerial), serial: c.deviceSerial, dueSince: due, overdueDays: Math.floor((now - due.getTime()) / DAY_MS) }));
    return {
        days: span,
        alerts: alerts.map(a => ({
            type: a.type,
            severity: a.severity,
            trap: a.deviceSerial ? (names.get(a.deviceSerial) || a.deviceSerial) : null,
            details: a.params,
            at: a.createdAt,
            read: a.read
        })),
        cardsDue
    };
}

// ---------- Logbook ----------

const getTreatmentsDeclaration = {
    name: 'get_treatments',
    description: 'Recent pest-control treatments from the farm logbook (spray, bait, lure, sanitation...) with their measured effect: catches per day before vs after, change and verdict (effective, partial, not_effective, pending, no_data).',
    parameters: {
        type: 'OBJECT',
        properties: {
            deviceSerial: { type: 'STRING', description: 'Only treatments covering this camera (optional)' },
            limit: { type: 'NUMBER', description: 'How many (default 5, at most 10)' }
        }
    }
};

async function executeGetTreatments({ deviceSerial, limit = 5, userId, user }) {
    if (!userId) return { error: 'Not authenticated.' };
    const visible = new Set((await visibleCameras(user)).map(c => c.deviceSerial));
    if (deviceSerial && deviceSerial !== 'all' && !visible.has(deviceSerial)) {
        return { error: `You do not have permission to access camera ${deviceSerial}.` };
    }
    const filter = deviceSerial && deviceSerial !== 'all' ? { cameraSerials: deviceSerial } : { cameraSerials: { $in: [...visible] } };
    const items = visible.size
        ? await Treatment.find(filter).sort({ at: -1 }).limit(Math.max(1, Math.min(Number(limit) || 5, 10))).lean()
        : [];
    const treatments = await Promise.all(items.map(async (t) => {
        const serials = t.cameraSerials.filter(s => visible.has(s));
        const effect = await treatmentService.effectOf(t, serials);
        return {
            at: t.at,
            type: t.type,
            product: t.product || null,
            activeIngredient: t.activeIngredient || null,
            area: t.area || null,
            traps: serials.length,
            effect: { catchesPerDayBefore: effect.before, catchesPerDayAfter: effect.after, changePct: effect.changePct, verdict: effect.status, windowDays: effect.windowDays }
        };
    }));
    return { total: treatments.length, treatments };
}

// ---------- Period comparison ----------

const comparePeriodsDeclaration = {
    name: 'compare_periods',
    description: 'Compare the last N days with the N days before: insects caught, flies per trap per day, change, by species and the traps that rose or fell the most. For "this week vs last week", "is it rising this month".',
    parameters: {
        type: 'OBJECT',
        properties: {
            days: { type: 'NUMBER', description: 'Length of each period in days (default 7, at most 90)' },
            deviceSerial: { type: 'STRING', description: 'One camera, or "all" (default)' }
        }
    }
};

async function executeComparePeriods({ days = 7, deviceSerial, userId, user }) {
    if (!userId) return { error: 'Not authenticated.' };
    const span = Math.max(1, Math.min(Number(days) || 7, 90));
    const cameras = await visibleCameras(user);
    let serials = cameras.map(c => c.deviceSerial);
    if (deviceSerial && deviceSerial !== 'all') {
        if (!serials.includes(deviceSerial)) return { error: `You do not have permission to access camera ${deviceSerial}.` };
        serials = [deviceSerial];
    }
    if (!serials.length) return { days: span, note: 'No cameras.' };
    const data = await catchStats.catchesBySerial(serials, span * 2);
    const current = data.dayKeys.slice(-span);
    const previous = data.dayKeys.slice(0, span);
    const entries = [...data.cameras.values()];
    const now = catchStats.summarize(entries, current);
    const before = catchStats.summarize(entries, previous);
    const speciesTotal = (keys) => {
        const totals = {};
        for (const { species } of entries) {
            for (const [name, byDay] of species) {
                for (const k of keys) totals[name] = (totals[name] || 0) + (byDay.get(k) || 0);
            }
        }
        return totals;
    };
    const nowSpecies = speciesTotal(current);
    const beforeSpecies = speciesTotal(previous);
    const names = new Map(cameras.map(c => [c.deviceSerial, c.deviceName || c.deviceSerial]));
    const traps = [...data.cameras.entries()].map(([serial, entry]) => {
        const a = catchStats.summarize([entry], current);
        const b = catchStats.summarize([entry], previous);
        return { trap: names.get(serial), caughtNow: round1(a.total), caughtBefore: b.trapDays ? round1(b.total) : null, changePct: a.trapDays && b.trapDays ? catchStats.percentChange(a.total, b.total) : null };
    }).filter(t => t.changePct !== null).sort((x, y) => Math.abs(y.changePct) - Math.abs(x.changePct)).slice(0, 5);
    return {
        days: span,
        current: { from: current[0], to: current.at(-1), caught: round1(now.total), fliesPerTrapPerDay: now.ftd },
        previous: { from: previous[0], to: previous.at(-1), caught: before.trapDays ? round1(before.total) : null, fliesPerTrapPerDay: before.ftd },
        changePct: now.trapDays && before.trapDays ? catchStats.percentChange(now.total, before.total) : null,
        bySpecies: Object.keys({ ...nowSpecies, ...beforeSpecies }).map(name => ({ species: name, now: round1(nowSpecies[name] || 0), before: round1(beforeSpecies[name] || 0) })),
        biggestChanges: traps
    };
}

// ---------- Capture pipeline (admins) ----------

const getPipelineHealthDeclaration = {
    name: 'get_pipeline_health',
    description: 'Admins only: the photo capture and AI pipeline over the last 24 hours (photos taken, analyzed, failed, waiting for a retry), cameras with problems, and background jobs that failed.',
    parameters: { type: 'OBJECT', properties: {} }
};

async function executeGetPipelineHealth({ userId, user }) {
    if (!userId) return { error: 'Not authenticated.' };
    if (!isAdmin(user)) return { error: 'Only administrators can see the capture pipeline.' };
    const overview = await require('../../services/pipelineStats').pipelineOverview();
    return {
        windowHours: overview.windowHours,
        totals: overview.totals,
        problemCameras: overview.cameras.filter(c => c.problems.length).slice(0, 10)
            .map(c => ({ name: c.deviceName || c.deviceSerial, problems: c.problems, photos: c.photos, failed: c.failed, lastPhotoAt: c.lastPhotoAt })),
        failedJobs: overview.jobs.filter(j => j.last && !j.last.ok).map(j => ({ job: j.id, at: j.last.startedAt, error: j.last.error })),
        note: 'Job runs are only known on the server that runs the background jobs, since it last started.'
    };
}

// Errors become a tool result the model can explain, not a failed request
const safe = (fn) => async (args) => {
    try {
        return await fn(args);
    } catch (err) {
        return { error: err.message };
    }
};

module.exports = {
    operationsDeclarations: [
        listReportsDeclaration,
        getReportSummaryDeclaration,
        sendReportDeclaration,
        getAlertsDeclaration,
        getTreatmentsDeclaration,
        comparePeriodsDeclaration,
        getPipelineHealthDeclaration
    ],
    operationsExecutors: {
        list_reports: safe(executeListReports),
        get_report_summary: safe(executeGetReportSummary),
        send_report_to_me: safe(executeSendReport),
        get_alerts: safe(executeGetAlerts),
        get_treatments: safe(executeGetTreatments),
        compare_periods: safe(executeComparePeriods),
        get_pipeline_health: safe(executeGetPipelineHealth)
    }
};
