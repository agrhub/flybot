const cron = require('node-cron');
const { cleanupOldData } = require('../services/s3Service');
const { syncCameraStatus } = require('../services/ezvizService');
const { autoCaptureDueCameras, retryFailedAnalyses } = require('./captureJob');
const { sendCardReminders } = require('../services/maintenanceService');
const { sendWeeklyReports } = require('../services/reportService');
const { sendDueReports } = require('../services/reportScheduleService');
const { sendMorningBriefs } = require('../services/morningBriefService');
const { sendMonthlyVietGapLogs } = require('../services/vietgapService');
const { sendHarvestReminders } = require('../services/harvestService');
const { syncPending: syncTrainingData } = require('../services/trainingSync');
const { resyncAll: resyncEzvizPolicies } = require('../services/ezvizRamService');
const { TIMEZONE } = require('../services/captureSchedule');
const jobStatus = require('../services/jobStatus');

/**
 * Wrap a job so a tick is skipped while the previous run is still going
 * (a slow EZVIZ/S3 call must not stack up runs). `id` names it in the admin pipeline monitor.
 */
function exclusive(name, job, id) {
    let running = false;
    return async () => {
        if (running) {
            console.warn(`⏭️ ${name} still running, skipping this tick`);
            if (id) jobStatus.skipped(id);
            return;
        }
        running = true;
        try {
            await (id ? jobStatus.track(id, job) : job());
        } catch (err) {
            console.error(`❌ ${name} failed:`, err.message);
        } finally {
            running = false;
        }
    };
}

const cleanupJob = exclusive('Retention cleanup', () => cleanupOldData(), 'cleanup');
const captureJob = exclusive('Capture', () => autoCaptureDueCameras(), 'capture');
const statusSyncJob = exclusive('Camera status sync', syncCameraStatus, 'statusSync');
const cardReminderJob = exclusive('Card reminders', async () => ({ sent: await sendCardReminders() }), 'cardReminders');
const weeklyReportJob = exclusive('Weekly reports', async () => ({ sent: await sendWeeklyReports() }), 'weeklyReports');
const morningBriefJob = exclusive('Morning briefs', () => sendMorningBriefs(), 'morningBriefs');
const vietgapJob = exclusive('VietGAP records', () => sendMonthlyVietGapLogs(), 'vietgapMonthly');
const harvestJob = exclusive('Harvest reminders', () => sendHarvestReminders(), 'harvestReminders');
const scheduledReportJob = exclusive('Scheduled reports', async () => ({ sent: await sendDueReports() }), 'scheduledReports');
const pestCountJob = exclusive('Pest count backfill', async () => ({
    photos: await require('../services/migrations').backfillPestCounts({ since: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) })
}), 'pestCount');
const trainingSyncJob = exclusive('Training sync', () => syncTrainingData(), 'trainingSync');
const aiRetryJob = exclusive('AI analysis retry', () => retryFailedAnalyses(), 'aiRetry');
const ezvizPolicyJob = exclusive('EZVIZ sub-account policies', async () => ({ changed: await resyncEzvizPolicies() }), 'ezvizPolicies');

/**
 * Start scheduled tasks (Cron Jobs)
 */
function startCronJobs() {
    // Cleanup old data: Every 60 minutes
    cron.schedule('*/60 * * * *', () => {
        cleanupJob();
    });

    // Photos stored without a pest count (e.g. by an older server during a rollout): every hour
    cron.schedule('20 * * * *', () => {
        pestCountJob();
    });

    // Reports emailed on their schedule: shortly after every hour
    cron.schedule('5 * * * *', () => {
        scheduledReportJob();
    });

    // Sync camera online/offline status: Every 1 minute
    cron.schedule('*/1 * * * *', () => {
        statusSyncJob();
    });

    // Snapshot capture & AI recognition: check every 5 minutes which cameras are due
    // (each camera has its own interval and optional daytime-only setting)
    cron.schedule('*/5 * * * *', () => {
        captureJob();
    });

    // Sticky card reminders: every morning, local time
    cron.schedule('0 7 * * *', () => {
        cardReminderJob();
    }, { timezone: TIMEZONE });

    // Morning brief for those who turned it on: every day, local time
    cron.schedule('30 6 * * *', () => {
        morningBriefJob();
    }, { timezone: TIMEZONE });

    // Pre-harvest intervals ending today: before the day's work, local time
    cron.schedule('0 6 * * *', () => {
        harvestJob();
    }, { timezone: TIMEZONE });

    // Last month's pesticide-use record (VietGAP) for those who turned it on: the 1st, local time
    cron.schedule('0 7 1 * *', () => {
        vietgapJob();
    }, { timezone: TIMEZONE });

    // Weekly report: Monday morning, local time
    cron.schedule('30 7 * * 1', () => {
        weeklyReportJob();
    }, { timezone: TIMEZONE });

    // Reviewed photos to Roboflow (no-op unless configured and turned on)
    cron.schedule('*/15 * * * *', () => {
        trainingSyncJob();
    });

    // Photos the AI failed on at capture: analyzed again, every 15 minutes (off the capture minute)
    cron.schedule('7,22,37,52 * * * *', () => {
        aiRetryJob();
    });

    // Removed camera access leaves the EZVIZ sub-accounts within the hour (no-op unless EZVIZ_RAM_TOKENS)
    cron.schedule('17 * * * *', () => {
        ezvizPolicyJob();
    });

    console.log("⏰ Periodic Cron jobs initialized.");
}

module.exports = {
    startCronJobs
};
