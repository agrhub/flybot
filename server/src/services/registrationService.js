const crypto = require('crypto');
const env = require('../config/env');
const { Camera, Snapshot, User } = require('../models');
const aws = require('../platforms/aws');
const entitlements = require('./entitlements');
const { sha256 } = require('./deviceService');

/**
 * Zero-touch self-registration of the public CamOS firmware (flybot-aws CONTRACTS 2a):
 *  - register: the camera sends its CSR (ECDSA P-256, made on the device); FlyBot has AWS IoT sign
 *    it, makes the thing, attaches the policy and the certificate, makes the KVS channel, and
 *    keeps the camera unclaimed with a hashed device token. No private key is ever made or sent.
 *  - unclaimed mode: 1 photo an hour, rule planner only, photos kept 24 h, hidden from everyone.
 *  - claim: a signed-in person types (or scans) the serial and the label code on /claim.
 *  - cleanup: never-claimed cameras are removed after 7 days (certificate, thing, channel, photos).
 */
const SERIAL = /^ESP[0-9A-F]{12}$/;
// Crockford base32 (no I, L, O, U)
const VERIFY_CODE = /^[0-9A-HJKMNP-TV-Z]{6}$/;
const MODEL = /^[A-Za-z0-9._-]{1,64}$/;
const FW = /^[A-Za-z0-9._+-]{1,40}$/;
const MAX_CSR = 4096;
const THING_ATTRIBUTE = 'self-registered';

// System limits (services/entitlements.js systemLimits)
const SYSTEM = entitlements.systemLimits();
const UNCLAIMED_PHOTO_EVERY_MS = SYSTEM.unclaimedPhotoEveryMinutes * 60 * 1000;
const UNCLAIMED_PHOTO_TTL_MS = SYSTEM.unclaimedPhotoTtlHours * 60 * 60 * 1000;
const UNCLAIMED_CAMERA_TTL_MS = SYSTEM.unclaimedCameraTtlDays * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CLAIM_MAX_FAILURES = 5;
const CLAIM_WINDOW_MS = 60 * 60 * 1000;

const newToken = () => crypto.randomBytes(32).toString('base64url');
const fail = (status, error, message, extra = {}) => ({ status, body: { ok: false, error, message, ...extra } });
const awsError = (err) => err?.name || err?.Code || 'Error';
const notFound = (err) => ['ResourceNotFoundException', 'NotFoundException'].includes(awsError(err));
const claimUrlOf = (serial) => `${env.APP_BASE_URL || env.DEVICE_API_BASE_URL || ''}/claim?sn=${encodeURIComponent(serial)}`;
const normCode = (code) => String(code || '').trim().toUpperCase();

/** A PEM PKCS#10 request: shape only (AWS IoT checks the signature and the key). */
function checkCsr(csr) {
    if (typeof csr !== 'string' || csr.length > MAX_CSR) return false;
    if (/PRIVATE KEY/.test(csr)) return false;
    const m = csr.trim().match(/^-----BEGIN (NEW )?CERTIFICATE REQUEST-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END (NEW )?CERTIFICATE REQUEST-----$/);
    if (!m) return false;
    const der = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    return der.length > 64 && der[0] === 0x30;
}

// ---------- AWS IoT / KVS ----------

async function iotSend(Command, input) {
    const client = aws.getClient('iot');
    return client.send(new Command(input));
}

/**
 * Remove what registration made in AWS: the certificate (detached from thing and policy, made
 * inactive, deleted), the thing and the KVS channel. A missing resource is not an error.
 * Returns { errors: [step: message] }.
 */
async function teardownAws({ deviceSerial, device = {} }) {
    const iot = require('@aws-sdk/client-iot');
    const thingName = device.thingName || deviceSerial;
    const errors = [];
    const step = async (name, fn) => {
        try {
            await fn();
        } catch (err) {
            if (!notFound(err)) errors.push(`${name}: ${awsError(err)} ${String(err.message || '').slice(0, 120)}`);
        }
    };
    if (device.certificateArn) {
        await step('DetachThingPrincipal', () => iotSend(iot.DetachThingPrincipalCommand, { thingName, principal: device.certificateArn }));
        await step('DetachPolicy', () => iotSend(iot.DetachPolicyCommand, { policyName: env.IOT_POLICY_NAME, target: device.certificateArn }));
    }
    if (device.certificateId) {
        await step('UpdateCertificate', () => iotSend(iot.UpdateCertificateCommand, { certificateId: device.certificateId, newStatus: 'INACTIVE' }));
        await step('DeleteCertificate', () => iotSend(iot.DeleteCertificateCommand, { certificateId: device.certificateId }));
    }
    await step('DeleteThing', () => iotSend(iot.DeleteThingCommand, { thingName }));
    await step('DeleteSignalingChannel', async () => {
        const kv = require('@aws-sdk/client-kinesis-video');
        const client = aws.getClient('kinesisVideo');
        let arn = device.kvsChannelArn;
        if (!arn) {
            const name = device.kvsChannelName || require('../platforms/kinesis').channelNameOf(deviceSerial);
            arn = (await client.send(new kv.DescribeSignalingChannelCommand({ ChannelName: name })))?.ChannelInfo?.ChannelARN;
        }
        if (arn) await client.send(new kv.DeleteSignalingChannelCommand({ ChannelARN: arn }));
    });
    return { errors };
}

/** The thing for a new self-registered camera; one left over from a failed cleanup is reused. */
async function ensureThing(thingName) {
    const iot = require('@aws-sdk/client-iot');
    try {
        await iotSend(iot.CreateThingCommand, { thingName, thingTypeName: env.IOT_THING_TYPE, attributePayload: { attributes: { flybot: THING_ATTRIBUTE } } });
        return { ok: true };
    } catch (err) {
        if (awsError(err) !== 'ResourceAlreadyExistsException') throw err;
    }
    // A thing of that name exists: only ours (made by registration) may be taken over
    const described = await iotSend(iot.DescribeThingCommand, { thingName });
    return { ok: described?.attributes?.flybot === THING_ATTRIBUTE };
}

/** Sign the CSR and attach the certificate. Returns { certificateArn, certificateId, certificatePem }. */
async function issueCertificate(thingName, csr) {
    const iot = require('@aws-sdk/client-iot');
    const made = await iotSend(iot.CreateCertificateFromCsrCommand, { certificateSigningRequest: csr, setAsActive: true });
    const cert = { certificateArn: made?.certificateArn, certificateId: made?.certificateId, certificatePem: made?.certificatePem };
    if (!cert.certificateArn || !cert.certificateId || !cert.certificatePem) throw new Error('AWS IoT returned no certificate');
    try {
        await iotSend(iot.AttachPolicyCommand, { policyName: env.IOT_POLICY_NAME, target: cert.certificateArn });
        await iotSend(iot.AttachThingPrincipalCommand, { thingName, principal: cert.certificateArn });
    } catch (err) {
        await teardownAws({ deviceSerial: thingName, device: { ...cert, thingName, kvsChannelArn: undefined } }).catch(() => {});
        throw err;
    }
    return cert;
}

async function dropCertificate(thingName, device) {
    await teardownAws({ deviceSerial: thingName, device: { certificateArn: device.certificateArn, certificateId: device.certificateId, thingName } })
        .catch(() => {});
}

// ---------- Register ----------

/**
 * POST /api/device/register { v, serial, verifyCode, model, fw, csr }. Returns { status, body }:
 * 201 with the contract body, 400 bad request, 409 serial_taken, 503 capacity / disabled / busy,
 * 502 aws_failed.
 */
async function register(body, now = new Date()) {
    if (!env.SELF_REGISTRATION) return fail(503, 'disabled', 'Self-registration is turned off on this server.');
    const b = body && typeof body === 'object' ? body : {};
    const serial = String(b.serial || '').trim().toUpperCase();
    const verifyCode = normCode(b.verifyCode);
    if (Number(b.v) !== 1) return fail(400, 'bad_request', 'v must be 1.');
    if (!SERIAL.test(serial)) return fail(400, 'bad_serial', 'serial must be ESP followed by the 12 hex digits of the MAC.');
    if (!VERIFY_CODE.test(verifyCode)) return fail(400, 'bad_request', 'verifyCode must be 6 Crockford base32 characters.');
    if (b.model !== undefined && !MODEL.test(String(b.model))) return fail(400, 'bad_request', 'model is not valid.');
    if (b.fw !== undefined && !FW.test(String(b.fw))) return fail(400, 'bad_request', 'fw is not valid.');
    if (!checkCsr(b.csr)) return fail(400, 'bad_csr', 'csr must be a PEM PKCS#10 certificate request (no private key).');
    const csr = b.csr.trim() + '\n';
    const csrHash = sha256(csr);

    const existing = await Camera.findOne({ deviceSerial: serial }).lean();
    if (existing) {
        const d = existing.device || {};
        const sameCode = existing.selfRegistered && normCode(existing.validateCode) === verifyCode;
        if (!sameCode || !existing.unclaimed || d.firstConnectAt) {
            return fail(409, 'serial_taken', 'This serial is already registered.');
        }
        if (!d.certificatePem) return fail(503, 'busy', 'Registration in progress, try again in a few seconds.', { retryAfter: 5 });
        // Idempotent retry before the first connection: the same certificate (a new key = a new one)
        let cert = { certificateArn: d.certificateArn, certificateId: d.certificateId, certificatePem: d.certificatePem };
        if (d.csrHash !== csrHash) {
            try {
                const fresh = await issueCertificate(d.thingName || serial, csr);
                await dropCertificate(d.thingName || serial, d);
                cert = fresh;
            } catch (err) {
                console.error(`❌ Re-registration of ${serial} failed: ${awsError(err)} ${err.message}`);
                return fail(502, 'aws_failed', 'The camera could not be registered with AWS IoT. Try again later.');
            }
        }
        const deviceToken = newToken();
        await Camera.updateOne({ _id: existing._id }, {
            $set: {
                'device.tokenHash': sha256(deviceToken), 'device.tokenIssuedAt': now, 'device.csrHash': csrHash,
                'device.certificateArn': cert.certificateArn, 'device.certificateId': cert.certificateId, 'device.certificatePem': cert.certificatePem,
                ...(b.fw ? { 'device.fw': String(b.fw) } : {})
            }
        });
        return created(serial, cert.certificatePem, deviceToken, d.kvsChannelName);
    }

    if ((await Camera.countDocuments({ selfRegistered: true, unclaimed: true })) >= entitlements.systemLimits().maxUnclaimed) {
        return fail(503, 'capacity', 'The demo has too many unclaimed cameras right now. Try again later.', { retryAfter: 3600 });
    }

    // The camera row first: the unique serial index settles two registrations racing
    let camera;
    try {
        camera = await Camera.create({
            deviceSerial: serial,
            userId: null,
            platform: 'camos',
            selfRegistered: true,
            unclaimed: true,
            validateCode: verifyCode,
            deviceName: `CamOS ${serial.slice(-4)}`,
            model: b.model ? String(b.model) : 'CamOS',
            deviceType: 'camos',
            trapKind: 'lure',
            captureIntervalMinutes: 60,
            status: 0,
            device: { thingName: serial, registeredAt: now, csrHash, ...(b.fw ? { fw: String(b.fw) } : {}) }
        });
    } catch (err) {
        if (err?.code === 11000) return fail(503, 'busy', 'Registration in progress, try again in a few seconds.', { retryAfter: 5 });
        throw err;
    }

    let cert = null;
    try {
        const thing = await ensureThing(serial);
        if (!thing.ok) {
            await Camera.deleteOne({ _id: camera._id });
            return fail(409, 'serial_taken', 'This serial is already registered.');
        }
        cert = await issueCertificate(serial, csr);
        const kvs = await require('../platforms/kinesis').ensureChannel(serial);
        const deviceToken = newToken();
        await Camera.updateOne({ _id: camera._id }, {
            $set: {
                'device.tokenHash': sha256(deviceToken), 'device.tokenIssuedAt': now,
                'device.certificateArn': cert.certificateArn, 'device.certificateId': cert.certificateId, 'device.certificatePem': cert.certificatePem,
                'device.kvsChannelName': kvs.channelName, 'device.kvsChannelArn': kvs.channelArn
            }
        });
        console.log(`📟 Camera ${serial} registered itself (unclaimed)`);
        return created(serial, cert.certificatePem, deviceToken, kvs.channelName);
    } catch (err) {
        console.error(`❌ Registration of ${serial} failed: ${awsError(err)} ${err.message}`);
        await teardownAws({ deviceSerial: serial, device: { ...(cert || {}), thingName: serial } }).catch(() => {});
        await Camera.deleteOne({ _id: camera._id }).catch(() => {});
        return fail(502, 'aws_failed', 'The camera could not be registered with AWS IoT. Try again later.');
    }
}

function created(serial, certificatePem, deviceToken, channelName) {
    return {
        status: 201,
        body: {
            ok: true,
            certificatePem,
            deviceToken,
            iot: { endpoint: env.IOT_ENDPOINT || null, thingName: serial, ...(require('../platforms/camos').liveCredentials() || {}) },
            kvs: { region: env.AWS_REGION, channelName: channelName || require('../platforms/kinesis').channelNameOf(serial) },
            claimUrl: claimUrlOf(serial),
            claimed: false
        }
    };
}

// ---------- Upload limits (device API) ----------

/**
 * May this camera upload a photo now? Unclaimed: 1 an hour. Any other CamOS camera: its
 * workspace plan's snapshotsPerDay in any 24 h (services/entitlements.js). Returns null, or { status: 429, body } with
 * the next allowed time as nextWakeAt.
 */
async function uploadLimit(camera, now = new Date()) {
    if (!camera) return null;
    if (camera.selfRegistered && camera.unclaimed) {
        const last = await Snapshot.findOne({ deviceSerial: camera.deviceSerial }).sort({ createdAt: -1 }).select('createdAt').lean();
        if (last && now - new Date(last.createdAt) < UNCLAIMED_PHOTO_EVERY_MS) {
            const next = new Date(new Date(last.createdAt).getTime() + UNCLAIMED_PHOTO_EVERY_MS);
            return fail(429, 'rate_limited', 'An unclaimed camera may upload one photo an hour.', { nextWakeAt: next.toISOString() });
        }
        return null;
    }
    const { snapshotsPerDay } = await entitlements.entitlementsOfCamera(camera);
    if (snapshotsPerDay === null) return null;
    const since = new Date(now.getTime() - DAY_MS);
    const recent = await Snapshot.find({ deviceSerial: camera.deviceSerial, createdAt: { $gt: since } }).sort({ createdAt: 1 }).select('createdAt').limit(snapshotsPerDay).lean();
    if (recent.length >= snapshotsPerDay) {
        const next = new Date(new Date(recent[0].createdAt).getTime() + DAY_MS);
        return fail(429, 'daily_limit', `This camera may upload ${snapshotsPerDay} photos a day on its plan.`, { nextWakeAt: next.toISOString() });
    }
    return null;
}

/** The photo of an unclaimed camera: hidden and deleted after 24 h. */
async function markUnclaimedPhoto(snapshot, now = new Date()) {
    const expiresAt = new Date(now.getTime() + UNCLAIMED_PHOTO_TTL_MS);
    await Snapshot.updateOne({ _id: snapshot._id }, { $set: { unclaimed: true, expiresAt } });
    snapshot.unclaimed = true;
    snapshot.expiresAt = expiresAt;
    return snapshot;
}

const unclaimedNextWake = (now = new Date()) => new Date(now.getTime() + UNCLAIMED_PHOTO_EVERY_MS);

// ---------- Claim ----------

const claimFailures = new Map(); // serial -> { count, since, lockedUntil }

function claimLocked(serial, now = Date.now()) {
    const entry = claimFailures.get(serial);
    if (!entry) return null;
    if (entry.lockedUntil && entry.lockedUntil > now) return entry.lockedUntil;
    if (entry.lockedUntil && entry.lockedUntil <= now) claimFailures.delete(serial);
    else if (now - entry.since > CLAIM_WINDOW_MS) claimFailures.delete(serial);
    return null;
}

function recordClaimFailure(serial, now = Date.now()) {
    let entry = claimFailures.get(serial);
    if (!entry || now - entry.since > CLAIM_WINDOW_MS) entry = { count: 0, since: now, lockedUntil: null };
    entry.count++;
    if (entry.count >= CLAIM_MAX_FAILURES) entry.lockedUntil = now + CLAIM_WINDOW_MS;
    claimFailures.set(serial, entry);
}

/** Tests */
function resetClaimLocks() {
    claimFailures.clear();
}

/**
 * POST /api/cameras/claim { serial, verifyCode, farmId?, trapKind?, captureIntervalMinutes?, deviceName? }
 * for the signed-in `user`. Returns { status, body } (FlyBot's { success, code, message } shape).
 */
async function claim(user, body, now = new Date()) {
    const b = body && typeof body === 'object' ? body : {};
    const serial = String(b.serial || '').trim().toUpperCase().slice(0, 64);
    const verifyCode = normCode(b.verifyCode).slice(0, 16);
    const notFoundAnswer = { status: 404, body: { success: false, code: 'NOT_FOUND', message: 'No camera waiting to be claimed matches this serial and code.' } };
    if (!serial || !verifyCode) return { status: 400, body: { success: false, code: 'BAD_REQUEST', message: 'serial and verifyCode are required.' } };
    const trapKind = b.trapKind === undefined ? 'lure' : b.trapKind;
    if (!['sticky', 'lure'].includes(trapKind)) return { status: 400, body: { success: false, code: 'BAD_REQUEST', message: 'trapKind must be sticky or lure.' } };
    const { CAPTURE_INTERVALS } = require('./captureSchedule');
    const interval = b.captureIntervalMinutes === undefined ? 30 : b.captureIntervalMinutes;
    if (!CAPTURE_INTERVALS.includes(interval)) return { status: 400, body: { success: false, code: 'BAD_REQUEST', message: `captureIntervalMinutes must be one of ${CAPTURE_INTERVALS.join(', ')}.` } };

    const lockedUntil = claimLocked(serial, now.getTime());
    if (lockedUntil) {
        return { status: 429, body: { success: false, code: 'LOCKED', message: 'Too many wrong codes for this serial. Try again later.', retryAfter: Math.ceil((lockedUntil - now.getTime()) / 1000) } };
    }

    const camera = await Camera.findOne({ deviceSerial: serial, selfRegistered: true }).lean();
    const userId = String(user?.id ?? user?._id ?? '');
    const codeOk = camera && (() => {
        const a = Buffer.from(normCode(camera.validateCode));
        const c = Buffer.from(verifyCode);
        return a.length === c.length && crypto.timingSafeEqual(a, c);
    })();
    if (!codeOk) {
        recordClaimFailure(serial, now.getTime());
        return notFoundAnswer;
    }
    // Claimed already: the same person gets it again, anyone else the same 404
    if (!camera.unclaimed) {
        if (String(camera.userId) === userId) return { status: 200, body: { success: true, alreadyClaimed: true, camera: claimedView(camera), preview: await previewOf(serial) } };
        return notFoundAnswer;
    }

    const actor = await User.findById(userId).select('role email name').lean();
    // The camera goes into the person's current workspace, within its plan's camera limit
    const workspace = user?.workspace || null;
    if (!workspace && !entitlements.operatorAccount(user)) {
        return { status: 403, body: { success: false, code: 'NO_WORKSPACE', message: 'You cannot add cameras in this workspace.' } };
    }
    if (workspace && !entitlements.operatorAccount(user) && !require('./workspaceService').canWorkIn(workspace)) {
        return { status: 403, body: { success: false, code: 'NO_WORKSPACE', message: 'You cannot add cameras in this workspace.' } };
    }
    const blocked = await entitlements.checkCameraLimit(user, workspace);
    if (blocked) return blocked;

    let farmId = null;
    if (b.farmId !== undefined && b.farmId !== null && b.farmId !== '') {
        const { Farm } = require('../models');
        const farmService = require('./farmService');
        const farm = /^[a-f0-9]{24}$/i.test(String(b.farmId)) ? await Farm.findById(String(b.farmId)) : null;
        if (!farm || !farmService.canEditFarm(user, farm)) return { status: 400, body: { success: false, code: 'BAD_FARM', message: 'Farm not found or not yours.' } };
        farmId = farm._id;
    }
    const deviceName = typeof b.deviceName === 'string' && b.deviceName.trim() ? b.deviceName.trim().slice(0, 60) : camera.deviceName;

    // Claimed once: whoever gets here first wins
    const updated = await Camera.findOneAndUpdate(
        { _id: camera._id, unclaimed: true },
        { $set: { userId, unclaimed: false, claimedAt: now, trapKind, captureIntervalMinutes: interval, deviceName, ...(farmId ? { farmId } : {}), ...(workspace ? { orgId: workspace.id } : {}) } },
        { new: true }
    ).lean();
    if (!updated) return notFoundAnswer;
    claimFailures.delete(serial);
    // Members of an organization workspace see it too
    if (workspace?.kind === 'organization') {
        const { Organization } = require('../models');
        const org = await Organization.findById(workspace.id);
        if (org) await require('./orgService').syncOrgShares(org);
    }
    // The preview photos stay with the new owner
    await Snapshot.updateMany({ deviceSerial: serial, unclaimed: true }, { $unset: { unclaimed: 1, expiresAt: 1 } });

    // Shadow: claimed, the owner's schedule, the timezone of the farm (or the GPS fix)
    let shadowSynced = true;
    try {
        await require('../platforms/camos').updateDesired(serial, { claimed: true, capture: { intervalMin: interval } });
    } catch (err) {
        shadowSynced = false;
        console.warn(`⚠️ Shadow not updated after the claim of ${serial}: ${err.message}`);
    }
    await require('./timezoneService').syncCamera(serial).catch(() => {});
    console.log(`🤝 Camera ${serial} claimed by ${actor?.email || userId}`);
    return { status: 200, body: { success: true, camera: claimedView(updated), shadowSynced, preview: await previewOf(serial) } };
}

function claimedView(camera) {
    return {
        deviceSerial: camera.deviceSerial,
        deviceName: camera.deviceName,
        trapKind: camera.trapKind,
        farmId: camera.farmId ? String(camera.farmId) : null,
        captureIntervalMinutes: camera.captureIntervalMinutes,
        platform: camera.platform,
        model: camera.model
    };
}

/** The camera's latest photo (the "first preview" shown after the claim), or null. */
async function previewOf(serial) {
    const snap = await Snapshot.findOne({ deviceSerial: serial }).sort({ createdAt: -1 }).select('s3Key imageUrl createdAt pestCount aiProcessed aiResults').lean();
    if (!snap) return null;
    return {
        snapshotId: String(snap._id),
        imageUrl: snap.s3Key || snap.imageUrl || null,
        at: snap.createdAt,
        count: snap.aiProcessed ? (snap.pestCount ?? null) : null
    };
}

// ---------- Live view ----------

/** Minutes of live view one request may ask for: the camera's workspace plan (operators: as asked). */
async function liveMinutes(camera, user, asked) {
    if (!camera || entitlements.operatorAccount(user)) return asked;
    return entitlements.capped(asked, (await entitlements.entitlementsOfCamera(camera)).liveMinutes);
}

// ---------- Cleanup ----------

async function deletePhotos(filter, limit = 500) {
    const { deleteS3Object } = require('./s3Service');
    const photos = await Snapshot.find(filter).select('s3Key lambda.evidence').limit(limit).lean();
    for (const p of photos) {
        for (const key of [p.s3Key, p.lambda?.evidence?.annotatedS3Key]) {
            if (key) await deleteS3Object(key).catch(err => console.warn(`⚠️ Photo ${key} not deleted: ${err.message}`));
        }
    }
    if (photos.length) await Snapshot.deleteMany({ _id: { $in: photos.map(p => p._id) } });
    return photos.length;
}

/**
 * Remove a self-registered camera completely: AWS (certificate, thing, channel), its photos and
 * the camera row. `keepOnAwsError`: leave the row for the next run when AWS refused a step.
 */
async function removeCamera(camera, { keepOnAwsError = false } = {}) {
    const { errors } = await teardownAws(camera);
    if (errors.length) console.warn(`⚠️ AWS cleanup of ${camera.deviceSerial} incomplete: ${errors.join('; ')}`);
    if (errors.length && keepOnAwsError) {
        await Camera.updateOne({ _id: camera._id }, { $set: { 'device.cleanupError': errors.join('; ').slice(0, 500) } }).catch(() => {});
        return { removed: false, errors };
    }
    let photos = 0;
    for (let n = 1; n > 0;) {
        n = await deletePhotos({ deviceSerial: camera.deviceSerial });
        photos += n;
    }
    await Camera.deleteOne({ _id: camera._id });
    return { removed: true, photos, errors };
}

/**
 * The hourly job (cron/scheduler.js, ENABLE_CRON): photos of unclaimed cameras older than 24 h,
 * and cameras never claimed within 7 days. Returns counts for the pipeline monitor.
 */
async function cleanupSelfRegistered({ now = new Date() } = {}) {
    const photos = await deletePhotos({ unclaimed: true, expiresAt: { $lte: now } });
    const stale = await Camera.find({ selfRegistered: true, unclaimed: true, 'device.registeredAt': { $lte: new Date(now.getTime() - UNCLAIMED_CAMERA_TTL_MS) } }).limit(50).lean();
    let cameras = 0;
    let failed = 0;
    for (const camera of stale) {
        const result = await removeCamera(camera, { keepOnAwsError: true }).catch(err => ({ removed: false, errors: [err.message] }));
        if (result.removed) cameras++; else failed++;
    }
    return { photos, cameras, failed };
}

module.exports = {
    SERIAL,
    VERIFY_CODE,
    UNCLAIMED_PHOTO_EVERY_MS,
    UNCLAIMED_PHOTO_TTL_MS,
    UNCLAIMED_CAMERA_TTL_MS,
    CLAIM_MAX_FAILURES,
    checkCsr,
    register,
    uploadLimit,
    markUnclaimedPhoto,
    unclaimedNextWake,
    claim,
    resetClaimLocks,
    previewOf,
    liveMinutes,
    teardownAws,
    removeCamera,
    cleanupSelfRegistered
};
