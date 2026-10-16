const env = require('../config/env');

/**
 * AWS clients shared by the platform adapters and the vision provider. Every client is built
 * lazily (the SDK packages load only when first used) and can be replaced in tests with
 * `setClient(name, fake)`, so no test ever talks to AWS.
 *
 * Credentials come from the default chain: the EC2 instance role, or AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN in the environment.
 */
const clients = new Map();
const overrides = new Map();

const FACTORIES = {
    lambda: () => {
        const { LambdaClient } = require('@aws-sdk/client-lambda');
        return new LambdaClient({ region: env.AWS_REGION, requestHandler: { requestTimeout: env.VISION_LAMBDA_TIMEOUT_S * 1000 } });
    },
    iotData: () => {
        const { IoTDataPlaneClient } = require('@aws-sdk/client-iot-data-plane');
        return new IoTDataPlaneClient({ region: env.AWS_REGION, ...(env.IOT_ENDPOINT ? { endpoint: `https://${env.IOT_ENDPOINT}` } : {}) });
    },
    kinesisVideo: () => {
        const { KinesisVideoClient } = require('@aws-sdk/client-kinesis-video');
        return new KinesisVideoClient({ region: env.AWS_REGION });
    },
    sts: () => {
        const { STSClient } = require('@aws-sdk/client-sts');
        return new STSClient({ region: env.AWS_REGION });
    }
};

function getClient(name) {
    if (overrides.has(name)) return overrides.get(name);
    if (!clients.has(name)) {
        const factory = FACTORIES[name];
        if (!factory) throw new Error(`Unknown AWS client "${name}"`);
        clients.set(name, factory());
    }
    return clients.get(name);
}

/** Tests: replace a client with an object whose `send(command)` answers; null restores the real one. */
function setClient(name, fake) {
    if (fake) overrides.set(name, fake);
    else overrides.delete(name);
}

/** The credentials the default chain resolves to (for SigV4 outside the SDK clients). */
async function credentials() {
    const { fromNodeProviderChain } = require('@aws-sdk/credential-provider-node');
    return fromNodeProviderChain()();
}

/** The command's constructor name, so a fake client can tell commands apart. */
const commandName = (command) => command?.constructor?.name || '';

module.exports = {
    getClient,
    setClient,
    credentials,
    commandName
};
