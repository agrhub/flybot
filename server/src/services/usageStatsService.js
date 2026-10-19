const { User, Session, AuditLog, Treatment, MaintenanceEvent, ChatSession, Camera, DailyStat, Snapshot } = require('../models');
const dailyStats = require('./dailyStats');

/**
 * How the app is used, for administrators, from what it already stores (no outside tracking):
 * people active (sessions, audited actions, field log entries), the features used over the last
 * 30 days, and twelve weeks of activity. Counts only; no one's content.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKS = 12;

const ids = (list) => list.filter(Boolean).map(String);

/** Distinct people who did something since `since` (and before `until`). */
async function activeUsers(since, until = new Date()) {
    const range = { $gte: since, $lt: until };
    const [audited, sessions, treated, maintained] = await Promise.all([
        AuditLog.distinct('actorId', { createdAt: range, actorId: { $ne: null } }),
        Session.distinct('userId', { lastSeenAt: range }),
        Treatment.distinct('createdBy', { createdAt: range }),
        MaintenanceEvent.distinct('userId', { createdAt: range })
    ]);
    return new Set([...ids(audited), ...ids(sessions), ...ids(treated), ...ids(maintained)]).size;
}

/** Sum of a numeric audit detail (e.g. rows imported) over some actions. */
async function auditSum(action, field, since) {
    const [row] = await AuditLog.aggregate([
        { $match: { action, createdAt: { $gte: since } } },
        { $group: { _id: null, n: { $sum: { $ifNull: [`$details.${field}`, 1] } } } }
    ]);
    return row?.n || 0;
}

async function usageStats(now = new Date()) {
    const d30 = new Date(now.getTime() - 30 * DAY_MS);
    const d7 = new Date(now.getTime() - 7 * DAY_MS);
    const d1 = new Date(now.getTime() - DAY_MS);

    const [users, newUsers, active7, active30, treatmentsManual, treatmentsAssistant, imported, cardChanges,
        chats, exports, reminders, reportsSent, cameras, camerasOnline, camerasReporting, photos30] = await Promise.all([
        User.countDocuments({ disabled: { $ne: true } }),
        User.countDocuments({ createdAt: { $gte: d30 } }),
        activeUsers(d7, now),
        activeUsers(d30, now),
        AuditLog.countDocuments({ action: 'treatment.created', createdAt: { $gte: d30 }, 'details.via': { $ne: 'assistant' } }),
        AuditLog.countDocuments({ action: 'treatment.created', createdAt: { $gte: d30 }, 'details.via': 'assistant' }),
        auditSum('treatment.imported', 'count', d30),
        MaintenanceEvent.countDocuments({ type: 'card_replaced', createdAt: { $gte: d30 } }),
        ChatSession.aggregate([
            { $match: { updatedAt: { $gte: d30 } } },
            { $unwind: '$messages' },
            { $match: { 'messages.role': 'user', 'messages.at': { $gte: d30 } } },
            { $group: { _id: null, n: { $sum: 1 }, people: { $addToSet: '$userId' } } }
        ]),
        AuditLog.countDocuments({ action: 'auth.data_exported', createdAt: { $gte: d30 } }),
        auditSum('org.log_reminded', 'count', d30),
        AuditLog.countDocuments({ action: 'org.report_sent', createdAt: { $gte: d30 } }),
        Camera.countDocuments({ unclaimed: { $ne: true }, simulated: { $ne: true } }),
        Camera.countDocuments({ status: 1, simulated: { $ne: true } }),
        Snapshot.distinct('deviceSerial', { createdAt: { $gte: d1 } }).then(list => list.length),
        DailyStat.aggregate([
            { $match: { day: { $gte: dailyStats.dayKeyOf(d30) } } },
            { $group: { _id: null, n: { $sum: '$scans' } } }
        ])
    ]);

    // Twelve weeks, the oldest first, each ending at the same time of day as now. All weeks run
    // at once (each week was a separate round-trip, so the series was as slow as twelve in a row).
    const weeks = await Promise.all(Array.from({ length: WEEKS }, (_, k) => {
        const until = new Date(now.getTime() - (WEEKS - 1 - k) * 7 * DAY_MS);
        const since = new Date(until.getTime() - 7 * DAY_MS);
        return Promise.all([
            activeUsers(since, until),
            Treatment.countDocuments({ createdAt: { $gte: since, $lt: until } }),
            DailyStat.aggregate([
                { $match: { day: { $gte: dailyStats.dayKeyOf(since), $lt: dailyStats.dayKeyOf(until) } } },
                { $group: { _id: null, n: { $sum: '$scans' } } }
            ])
        ]).then(([people, logged, scans]) => ({
            from: dailyStats.dayKeyOf(since), activeUsers: people, treatments: logged, photos: scans[0]?.n || 0
        }));
    }));

    return {
        generatedAt: now.toISOString(),
        people: { users, newUsers30: newUsers, active7, active30 },
        features30: {
            treatmentsLogged: treatmentsManual,
            treatmentsByAssistant: treatmentsAssistant,
            treatmentsImported: imported,
            cardChanges,
            assistantQuestions: chats[0]?.n || 0,
            assistantUsers: chats[0]?.people?.length || 0,
            dataExports: exports,
            remindersSent: reminders,
            cooperativeReportsSent: reportsSent
        },
        cameras: { total: cameras, online: camerasOnline, photo24h: camerasReporting, photos30: photos30[0]?.n || 0 },
        weeks
    };
}

module.exports = {
    activeUsers,
    usageStats
};
