/**
 * Release channels of the CamOS firmware: alpha (internal test cameras), beta (wider test), stable (everyone).
 * A release has one channel and may be the current one of its model *in that channel*. A camera has a channel too
 * (stable unless an admin chose another) and takes the newest current release of its own channel or of a more stable
 * one: a beta camera gets the newer of beta-current and stable-current, a stable camera only stable-current.
 * Releases and cameras from before channels existed are stable.
 */
const CHANNELS = ['alpha', 'beta', 'stable'];
const RANK = { alpha: 0, beta: 1, stable: 2 };

const channelOf = (doc) => (CHANNELS.includes(doc?.channel) ? doc.channel : 'stable');
const cameraChannel = (camera) => (CHANNELS.includes(camera?.firmware?.channel) ? camera.firmware.channel : 'stable');

/** Channels whose releases a camera on `cameraCh` takes: its own and the more stable ones. */
const acceptedChannels = (cameraCh) => CHANNELS.filter(c => RANK[c] >= RANK[CHANNELS.includes(cameraCh) ? cameraCh : 'stable']);

const accepts = (cameraCh, releaseCh) => acceptedChannels(cameraCh).includes(CHANNELS.includes(releaseCh) ? releaseCh : 'stable');

/**
 * The release for a camera on `cameraCh` among the current releases of its model: the newest version of the channels
 * it accepts; on the same version the more stable channel. Null when there is none.
 */
function pickRelease(currentReleases, cameraCh) {
    let best = null;
    for (const r of currentReleases || []) {
        if (!r?.current || !accepts(cameraCh, channelOf(r))) continue;
        if (!best) {
            best = r;
            continue;
        }
        // fleetService requires this module: loaded here, not at the top
        const d = require('./fleetService').compareVersions(r.version, best.version);
        if (d > 0 || (d === 0 && RANK[channelOf(r)] > RANK[channelOf(best)])) best = r;
    }
    return best;
}

/** Mongo filter for releases in the given channels (a release without a channel is stable). */
function channelFilter(channels) {
    return channels.includes('stable') ? { $or: [{ channel: { $in: channels } }, { channel: { $exists: false } }, { channel: null }] } : { channel: { $in: channels } };
}

/** The promotion after `channel`: alpha -> beta -> stable, null for stable. */
const nextChannel = (channel) => ({ alpha: 'beta', beta: 'stable' }[channel] || null);

module.exports = {
    CHANNELS,
    RANK,
    channelOf,
    cameraChannel,
    acceptedChannels,
    accepts,
    pickRelease,
    channelFilter,
    nextChannel
};
