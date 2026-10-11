const crypto = require('crypto');
const jpeg = require('jpeg-js');
const s3Service = require('./s3Service');

// The upload limit shown in the profile ("JPG, PNG max 2MB"); the browser turns either into a JPEG
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
// The browser sends a small square; anything larger than this is refused rather than stored
const AVATAR_MAX_SIDE = 1024;
const AVATAR_MIN_SIDE = 16;
const AVATAR_QUALITY = 85;
const AVATAR_KEY_REGEX = /^avatars\/([a-f0-9]{24})\/[a-f0-9]{16}\.jpg$/;

/** The stored avatar of this user (older free-text values are not files and are ignored). */
function avatarKeyOf(user) {
    const match = String(user?.avatar || '').match(AVATAR_KEY_REGEX);
    return match && match[1] === String(user._id) ? user.avatar : null;
}

/** What the browser loads: the file name changes on every upload, so it can be cached. */
function avatarUrlOf(user) {
    const key = avatarKeyOf(user);
    return key ? `/api/auth/avatar?v=${key.split('/').pop().replace('.jpg', '')}` : '';
}

/**
 * Check the upload is a real JPEG of a sensible size and encode it again: what is stored holds
 * only the pixels (no camera or location details from the original file).
 * Returns { buffer } or { error }.
 */
function cleanImage(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) return { error: 'Please choose a JPG or PNG image.' };
    if (buffer.length > AVATAR_MAX_BYTES) return { error: 'The image must be 2 MB or smaller.' };
    // JPEG files start with FF D8 FF
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) return { error: 'Please choose a JPG or PNG image.' };
    let image;
    try {
        image = jpeg.decode(buffer, { useTArray: true, maxResolutionInMP: 2, maxMemoryUsageInMB: 64 });
    } catch {
        return { error: 'This image could not be read.' };
    }
    const { width, height } = image;
    if (width > AVATAR_MAX_SIDE || height > AVATAR_MAX_SIDE || width < AVATAR_MIN_SIDE || height < AVATAR_MIN_SIDE) {
        return { error: 'This image could not be read.' };
    }
    return { buffer: Buffer.from(jpeg.encode({ data: image.data, width, height }, AVATAR_QUALITY).data) };
}

/** Store a new avatar for the user and remove the previous file. Saves the user. */
async function saveAvatar(user, buffer) {
    const previous = avatarKeyOf(user);
    const key = `avatars/${user._id}/${crypto.randomBytes(8).toString('hex')}.jpg`;
    await s3Service.uploadSnapshot(key, buffer, 'image/jpeg');
    user.avatar = key;
    await user.save();
    if (previous) await removeFile(previous);
    return key;
}

/** Remove the user's avatar (file and reference). Saves the user. */
async function removeAvatar(user) {
    const previous = avatarKeyOf(user);
    user.avatar = '';
    await user.save();
    if (previous) await removeFile(previous);
}

async function removeFile(key) {
    try {
        await s3Service.deleteS3Object(key);
    } catch (err) {
        // A file left behind only costs storage; the reference is already gone
        console.error('⚠️ Removing avatar file failed:', err.message);
    }
}

module.exports = {
    AVATAR_MAX_BYTES,
    AVATAR_MAX_SIDE,
    avatarKeyOf,
    avatarUrlOf,
    cleanImage,
    saveAvatar,
    removeAvatar,
    removeFile
};
