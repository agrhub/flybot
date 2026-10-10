const { S3Client } = require('@aws-sdk/client-s3');
const { S3_REGION, S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY } = require('./env');

const s3Client = new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    credentials: {
        accessKeyId: S3_ACCESS_KEY,
        secretAccessKey: S3_SECRET_KEY,
    },
    forcePathStyle: true,
});

// Automatically compute Content-MD5 for MinIO/S3 when invoking DeleteObjectsCommand
s3Client.middlewareStack.add(
    (next, context) => async (args) => {
        if (context.commandName === 'DeleteObjectsCommand' && args.request && args.request.body) {
            const md5 = require('crypto').createHash('md5').update(args.request.body).digest('base64');
            args.request.headers['content-md5'] = md5;
        }
        return next(args);
    },
    { step: 'finalizeRequest' }
);

module.exports = { s3Client };
