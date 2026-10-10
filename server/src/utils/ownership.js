const { Camera } = require('../models');

/**
 * Serial numbers of all cameras the user has added.
 */
async function getUserSerials(userId) {
    if (!userId) return [];
    const cams = await Camera.find({ userId }).select('deviceSerial');
    return cams.map(c => c.deviceSerial);
}

/**
 * True when the user has this camera in their account.
 */
async function userOwnsCamera(userId, deviceSerial) {
    if (!userId || !deviceSerial) return false;
    return !!(await Camera.exists({ userId, deviceSerial }));
}

module.exports = {
    getUserSerials,
    userOwnsCamera
};
