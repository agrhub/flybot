const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { s3Client } = require('../config/s3');
const { S3_BUCKET } = require('../config/env');
const { canViewSerial } = require('../utils/ownership');
const { sendServerError } = require('../utils/http');

// Only snapshot images are served: snapshots/<deviceSerial>/<file>
const SNAPSHOT_KEY_REGEX = /^snapshots\/([A-Za-z0-9_-]+)\/[A-Za-z0-9_.-]+$/;

/**
 * Pipe one S3 object to the response (404 when missing).
 */
async function pipeSnapshot(res, fileKey, { cacheControl = 'private, max-age=86400', download = false } = {}) {
    try {
        const data = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: fileKey }));

        res.setHeader('Content-Type', data.ContentType || 'image/jpeg');
        res.setHeader('Cache-Control', cacheControl);
        if (download) {
            res.attachment(fileKey.split('/').pop());
        }

        if (data.Body) {
            data.Body.pipe(res);
        } else {
            res.status(404).json({ success: false, message: "File not found" });
        }
    } catch (error) {
        if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
            return res.status(404).json({ success: false, message: "File not found" });
        }
        sendServerError(res, error, { context: 'S3 stream' });
    }
}

/**
 * Proxy stream / download a snapshot image from S3 for a camera the user owns
 */
async function streamS3File(req, res) {
    let fileKey;
    try {
        fileKey = decodeURIComponent(req.path.replace(/^\//, '')); // Strip leading slash if present
    } catch {
        return res.status(400).json({ success: false, message: "Invalid file path." });
    }

    const match = fileKey.match(SNAPSHOT_KEY_REGEX);
    // Same 404 for malformed keys and other users' cameras so keys can't be probed
    if (!match || !(await canViewSerial(req.user, match[1]))) {
        return res.status(404).json({ success: false, message: "File not found" });
    }

    // Private: images are per-user, so shared caches must not store them
    return pipeSnapshot(res, fileKey, { download: req.query.download === '1' });
}

module.exports = {
    SNAPSHOT_KEY_REGEX,
    pipeSnapshot,
    streamS3File
};
