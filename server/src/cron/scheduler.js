const cron = require('node-cron');
const { cleanupOldData } = require('../services/s3Service');
const { syncCameraStatus } = require('../services/ezvizService');
const { autoCaptureAllCameras } = require('./captureJob');

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

    // Snapshot capture & AI recognition: Every 30 minutes
    cron.schedule('*/30 * * * *', () => {
        autoCaptureAllCameras();
    });

    console.log("⏰ Periodic Cron jobs initialized.");
}

module.exports = {
    startCronJobs
};
