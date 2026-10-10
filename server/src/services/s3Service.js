const { PutObjectCommand, DeleteObjectsCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { s3Client } = require('../config/s3');
const { S3_BUCKET } = require('../config/env');
const { Snapshot } = require('../models');

async function getSignedDownloadUrl(objectKey) {
    try {
        const command = new GetObjectCommand({
            Bucket: S3_BUCKET,
            Key: objectKey
        });

        const url = await getSignedUrl(s3Client, command, {
            expiresIn: 3600 // URL valid for 1 hour
        });

        return url;
    } catch (err) {
        console.error("getSignedDownloadUrl error:", err.message, objectKey);
        return null;
    }
}

async function uploadSnapshot(s3Key, buffer, contentType = 'image/jpeg') {
    return await s3Client.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        Body: buffer,
        ContentType: contentType
    }));
}

async function getS3Object(key) {
    const command = new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: key
    });
    return await s3Client.send(command);
}

/**
 * Remove data older than the retention period (admin setting) from S3 and Database
 */
async function cleanupOldData() {
    console.log(`[${new Date().toISOString()}] 🧹 Starting periodic cleanup process...`);

    const cutoffDate = new Date();
    const { retentionMonths } = await require('./settingsService').getSettings();
    cutoffDate.setMonth(cutoffDate.getMonth() - retentionMonths);

    try {
        let oldRecords = [];
        do {
            oldRecords = await Snapshot.find({
                createdAt: { $lt: cutoffDate }
            }).select('_id s3Key').limit(1000).lean();

            if (oldRecords.length === 0) {
                console.log("✨ No expired data to clean up.");
                break;
            }

            const s3KeysToDelete = oldRecords
                .filter(r => r.s3Key)
                .map(r => ({ Key: r.s3Key }));

            if (s3KeysToDelete.length > 0) {
                const deleteParams = {
                    Bucket: S3_BUCKET,
                    Delete: { Objects: s3KeysToDelete }
                };
                await s3Client.send(new DeleteObjectsCommand(deleteParams));
                console.log(`🗑️ Deleted ${s3KeysToDelete.length} images from S3.`);
            }

            const recordIds = oldRecords.map(r => r._id);
            const dbResult = await Snapshot.deleteMany({
                _id: { $in: recordIds }
            });

            console.log(`✅ Cleaned up ${dbResult.deletedCount} records from Database.`);
        } while (oldRecords.length > 0);
    } catch (error) {
        console.error("❌ Cleanup error:", error.message);
    }
}

module.exports = {
    getSignedDownloadUrl,
    uploadSnapshot,
    getS3Object,
    cleanupOldData
};
