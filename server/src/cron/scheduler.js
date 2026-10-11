const cron = require('node-cron');
const { cleanupOldData } = require('../services/s3Service');
const { syncCameraStatus } = require('../services/ezvizService');
const { autoCaptureDueCameras } = require('./captureJob');
const { sendCardReminders } = require('../services/maintenanceService');
const { sendWeeklyReports } = require('../services/reportService');
const { sendDueReports } = require('../services/reportScheduleService');
const { syncPending: syncTrainingData } = require('../services/trainingSync');
const { resyncAll: resyncEzvizPolicies } = require('../services/ezvizRamService');
const { TIMEZONE } = require('../services/captureSchedule');

/**
 * Wrap a job so a tick is skipped while the previous run is still going
 * (a slow EZVIZ/S3 call must not stack up runs).
 */
function exclusive(name, job) {
    let running = false;
    return async () => {
        if (running) {
            console.warn(`⏭️ ${name} still running, skipping this tick`);
            return;
        }
        running = true;
        try {
            await job();
        } catch (err) {
            console.error(`❌ ${name} failed:`, err.message);
        } finally {
            running = false;
        }
    };
}

const cleanupJob = exclusive('Retention cleanup', cleanupOldData);
const statusSyncJob = exclusive('Camera status sync', syncCameraStatus);
const cardReminderJob = exclusive('Card reminders', sendCardReminders);
const weeklyReportJob = exclusive('Weekly reports', sendWeeklyReports);
const scheduledReportJob = exclusive('Scheduled reports', () => sendDueReports());
const trainingSyncJob = exclusive('Training sync', () => syncTrainingData());
const ezvizPolicyJob = exclusive('EZVIZ sub-account policies', resyncEzvizPolicies);

/**
 * Start scheduled tasks (Cron Jobs)
 */
function startCronJobs() {
    // Cleanup old data: Every 60 minutes
    cron.schedule('*/60 * * * *', () => {
        cleanupJob();
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
        autoCaptureDueCameras();
    });

    // Sticky card reminders: every morning, local time
    cron.schedule('0 7 * * *', () => {
        cardReminderJob();
    }, { timezone: TIMEZONE });

    // Weekly report: Monday morning, local time
    cron.schedule('30 7 * * 1', () => {
        weeklyReportJob();
    }, { timezone: TIMEZONE });

    // Reviewed photos to Roboflow (no-op unless configured and turned on)
    cron.schedule('*/15 * * * *', () => {
        trainingSyncJob();
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
