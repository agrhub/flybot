const cron = require('node-cron');
const { cleanupOldData } = require('../services/s3Service');
const { syncCameraStatus } = require('../services/ezvizService');
const { autoCaptureDueCameras } = require('./captureJob');

/**
 * Start scheduled tasks (Cron Jobs)
 */
function startCronJobs() {
    // Cleanup old data: Every 60 minutes
    cron.schedule('*/60 * * * *', () => {
        cleanupOldData();
    });

    // Sync camera online/offline status: Every 1 minute
    cron.schedule('*/1 * * * *', () => {
        syncCameraStatus();
    });

    // Snapshot capture & AI recognition: check every 5 minutes which cameras are due
    // (each camera has its own interval and optional daytime-only setting)
    cron.schedule('*/5 * * * *', () => {
        autoCaptureDueCameras();
    });

    console.log("⏰ Periodic Cron jobs initialized.");
}

module.exports = {
    startCronJobs
};
