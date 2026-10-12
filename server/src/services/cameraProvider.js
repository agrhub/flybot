const { Camera } = require('../models');
const ezvizService = require('./ezvizService');
const camosService = require('./camosService');

/**
 * What differs between the camera platforms a device is reached through (Camera.provider):
 * EZVIZ Open Platform or CamOS. Callers use these instead of calling one platform directly.
 */

async function providerOf(deviceSerial) {
    const camera = await Camera.findOne({ deviceSerial }).select('provider').lean();
    return camera?.provider === 'camos' ? 'camos' : 'ezviz';
}

/**
 * Have the camera take a photo now. Returns { picUrl } (a link the photo can be downloaded from
 * for a short while), or null when the camera gave none (offline, busy, platform error).
 */
async function captureImage(deviceSerial) {
    if (await providerOf(deviceSerial) === 'camos') {
        try {
            const shot = await camosService.captureImage(deviceSerial);
            return shot?.imageUrl ? { picUrl: shot.imageUrl } : null;
        } catch (err) {
            console.log(`Can't get image from device ${deviceSerial} (CamOS ${err.code || err.message})`);
            return null;
        }
    }
    const captureRes = await ezvizService.captureDevice(deviceSerial);
    return captureRes.code == '200' && captureRes.data?.picUrl ? { picUrl: captureRes.data.picUrl } : null;
}

module.exports = {
    providerOf,
    captureImage
};
