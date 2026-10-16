const { S3Client } = require('@aws-sdk/client-s3');
const { S3_REGION, S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY } = require('./env');

// Keys given: a MinIO / R2 / S3 account. None: the default AWS credential chain (the EC2 instance
// role on flybot-aws), with real S3 at its regional endpoint
const explicitCredentials = !!(S3_ACCESS_KEY && S3_SECRET_KEY);
const customEndpoint = !!S3_ENDPOINT;

const s3Client = new S3Client({
    region: S3_REGION === 'auto' && !customEndpoint ? (process.env.AWS_REGION || 'ap-southeast-2') : S3_REGION,
    ...(customEndpoint ? { endpoint: S3_ENDPOINT } : {}),
    ...(explicitCredentials ? { credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY } } : {}),
    // Path-style addressing for MinIO and friends; virtual-hosted for AWS S3
    forcePathStyle: customEndpoint,
    // No request may hang a capture or the cleanup indefinitely
    requestHandler: { connectionTimeout: 10000, requestTimeout: 60000 }
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
