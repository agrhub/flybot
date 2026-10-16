const crypto = require('crypto');
const env = require('../config/env');
const { Camera } = require('../models');
const aws = require('./aws');

/**
 * CameraPlatform "kinesis": live view over Kinesis Video Streams WebRTC (CONTRACTS section 4).
 * FlyBot owns one signaling channel per CamOS camera (`cam-<serial>`); the camera joins as
 * MASTER, the browser as VIEWER with the config from `liveSession` (signaling endpoints, ICE
 * servers and 15-minute credentials from the viewer role). A camera whose `platform` is
 * "kinesis" has live view only (no snapshots): it is a plain KVS source.
 */
const PLATFORM = 'kinesis';
// Viewer credentials (STS AssumeRole) last this long
const VIEWER_SESSION_S = 15 * 60;
const CHANNEL_NAME = /^[A-Za-z0-9_.-]{1,256}$/;

const channelNameOf = (deviceSerial) => `cam-${deviceSerial}`;

function listCameras(filter = {}) {
    return Camera.find({ ...filter, platform: PLATFORM });
}

/**
 * The channel's ARN, creating the channel when it does not exist yet. Stored on the camera.
 */
async function ensureChannel(deviceSerial) {
    const name = channelNameOf(deviceSerial);
    if (!CHANNEL_NAME.test(name)) throw new Error('Invalid channel name');
    const camera = await Camera.findOne({ deviceSerial }).select('device.kvsChannelArn device.kvsChannelName').lean();
    if (camera?.device?.kvsChannelArn && camera.device.kvsChannelName === name) {
        return { channelName: name, channelArn: camera.device.kvsChannelArn, created: false };
    }
    const { DescribeSignalingChannelCommand, CreateSignalingChannelCommand } = require('@aws-sdk/client-kinesis-video');
    const client = aws.getClient('kinesisVideo');
    let arn;
    let created = false;
    try {
        const described = await client.send(new DescribeSignalingChannelCommand({ ChannelName: name }));
        arn = described?.ChannelInfo?.ChannelARN;
    } catch (err) {
        if (err?.name !== 'ResourceNotFoundException') throw err;
    }
    if (!arn) {
        const made = await client.send(new CreateSignalingChannelCommand({
            ChannelName: name,
            ChannelType: 'SINGLE_MASTER',
            SingleMasterConfiguration: { MessageTtlSeconds: 60 },
            Tags: [{ Key: 'flybot', Value: 'camera' }, { Key: 'serial', Value: deviceSerial }]
        }));
        arn = made?.ChannelARN;
        created = true;
    }
    if (!arn) throw new Error('KVS gave no channel ARN');
    await Camera.updateMany({ deviceSerial }, { $set: { 'device.kvsChannelName': name, 'device.kvsChannelArn': arn } });
    return { channelName: name, channelArn: arn, created };
}

/** The VIEWER's signaling endpoints (WSS + HTTPS) for a channel. */
async function signalingEndpoints(channelArn) {
    const { GetSignalingChannelEndpointCommand } = require('@aws-sdk/client-kinesis-video');
    const res = await aws.getClient('kinesisVideo').send(new GetSignalingChannelEndpointCommand({
        ChannelARN: channelArn,
        SingleMasterChannelEndpointConfiguration: { Protocols: ['WSS', 'HTTPS'], Role: 'VIEWER' }
    }));
    const out = {};
    for (const item of res?.ResourceEndpointList || []) out[item.Protocol] = item.ResourceEndpoint;
    if (!out.WSS || !out.HTTPS) throw new Error('KVS gave no signaling endpoints');
    return out;
}

/** TURN servers from KVS (plus the regional STUN server), for the browser's RTCPeerConnection. */
async function iceServers(channelArn, httpsEndpoint, clientId) {
    const servers = [{ urls: `stun:stun.kinesisvideo.${env.AWS_REGION}.amazonaws.com:443` }];
    try {
        const { KinesisVideoSignalingClient, GetIceServerConfigCommand } = require('@aws-sdk/client-kinesis-video-signaling');
        const client = new KinesisVideoSignalingClient({ region: env.AWS_REGION, endpoint: httpsEndpoint });
        const res = await client.send(new GetIceServerConfigCommand({ ChannelARN: channelArn, ClientId: clientId }));
        for (const server of res?.IceServerList || []) {
            servers.push({ urls: server.Uris, username: server.Username, credential: server.Password });
        }
    } catch (err) {
        // STUN alone still works on most networks; TURN is a nicety the viewer can do without
        console.warn(`⚠️ KVS ICE server config not available: ${err.message}`);
    }
    return servers;
}

/**
 * Credentials for the browser: the viewer role assumed for 15 minutes with a session policy
 * limited to this one channel. Without KVS_VIEWER_ROLE_ARN there is nothing safe to hand out.
 */
async function viewerCredentials(channelArn, userId) {
    if (!env.KVS_VIEWER_ROLE_ARN) {
        const err = new Error('Live view of CamOS cameras is not set up on this server (KVS_VIEWER_ROLE_ARN).');
        err.code = 'LIVE_NOT_CONFIGURED';
        err.status = 503;
        throw err;
    }
    const { AssumeRoleCommand } = require('@aws-sdk/client-sts');
    const res = await aws.getClient('sts').send(new AssumeRoleCommand({
        RoleArn: env.KVS_VIEWER_ROLE_ARN,
        RoleSessionName: `flybot-viewer-${String(userId || 'anon').slice(-16)}`.replace(/[^A-Za-z0-9_=,.@-]/g, '-'),
        DurationSeconds: VIEWER_SESSION_S,
        Policy: JSON.stringify({
            Version: '2012-10-17',
            Statement: [{
                Effect: 'Allow',
                Action: ['kinesisvideo:ConnectAsViewer', 'kinesisvideo:GetIceServerConfig', 'kinesisvideo:GetSignalingChannelEndpoint', 'kinesisvideo:DescribeSignalingChannel'],
                Resource: channelArn
            }]
        })
    }));
    const c = res?.Credentials;
    if (!c?.AccessKeyId) throw new Error('STS gave no credentials');
    return {
        accessKeyId: c.AccessKeyId,
        secretAccessKey: c.SecretAccessKey,
        sessionToken: c.SessionToken,
        expiration: c.Expiration instanceof Date ? c.Expiration.toISOString() : c.Expiration
    };
}

/**
 * What the browser needs to join as VIEWER (CONTRACTS section 4):
 * { platform, channelARN, channelName, region, signalingEndpoints, iceServers, clientId,
 *   credentials, expiresAt }.
 */
async function liveSession(deviceSerial, { user } = {}) {
    const { channelName, channelArn } = await ensureChannel(deviceSerial);
    const clientId = `viewer-${crypto.randomBytes(6).toString('hex')}`;
    const [endpoints, credentials] = await Promise.all([signalingEndpoints(channelArn), viewerCredentials(channelArn, user?.id)]);
    const ice = await iceServers(channelArn, endpoints.HTTPS, clientId);
    return {
        platform: PLATFORM,
        channelARN: channelArn,
        channelName,
        region: env.AWS_REGION,
        signalingEndpoints: endpoints,
        iceServers: ice,
        clientId,
        credentials,
        expiresAt: credentials.expiration || new Date(Date.now() + VIEWER_SESSION_S * 1000).toISOString()
    };
}

/** No recordings on KVS signaling channels: nothing to play back. */
async function playback() {
    return { platform: PLATFORM, kind: 'none', items: [] };
}

async function snapshot() {
    return null;
}

async function setCaptureSchedule() {
    const err = new Error('A KVS-only camera has no capture schedule.');
    err.code = 'NOT_SUPPORTED';
    throw err;
}

async function getStatus(deviceSerial) {
    const camera = await Camera.findOne({ deviceSerial }).select('status lastSync device').lean();
    if (!camera) return null;
    return {
        platform: PLATFORM,
        online: Number(camera.status) === 1,
        power: { mode: 'powered' },
        sleeping: false,
        wakeAt: null,
        lastSeenAt: camera.device?.lastSeenAt || camera.lastSync || null,
        channelName: camera.device?.kvsChannelName || channelNameOf(deviceSerial)
    };
}

module.exports = {
    PLATFORM,
    VIEWER_SESSION_S,
    channelNameOf,
    ensureChannel,
    listCameras,
    snapshot,
    liveSession,
    playback,
    setCaptureSchedule,
    getStatus
};
