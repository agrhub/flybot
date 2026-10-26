const { Camera, Snapshot } = require('../models');
const { CAPTURE_INTERVALS } = require('../services/captureSchedule');
const { countPests } = require('../services/notificationService');
const ezvizService = require('../services/ezvizService');
const ezvizRamService = require('../services/ezvizRamService');
const { sendServerError } = require('../utils/http');
const { recordAudit } = require('../services/auditService');
const { latestSnapshotTimeByCamera } = require('../services/snapshotQueries');
const { CARD_REMINDER_DAYS, cardDueAt } = require('../services/maintenanceService');
const { TRAP_KINDS, DEFAULT_TRAP_KIND } = require('../constants/trap');

const cameraTarget = (camera) => ({ type: 'camera', id: camera.deviceSerial, label: camera.deviceName });
const platforms = require('../platforms');
const camosPlatform = require('../platforms/camos');
const deviceService = require('../services/deviceService');

/** The CamOS device fields a viewer may see (power mode, sleep, battery, network, firmware). */
function deviceView(camera, now = new Date()) {
    const d = camera.device || {};
    const sleeping = !!d.sleeping && (!d.wakeAt || new Date(d.wakeAt) > now);
    return {
        paired: !!d.tokenHash,
        pairedAt: d.pairedAt || null,
        fw: d.fw || null,
        net: d.net || null,
        rssi: d.rssi ?? null,
        battery: d.battery || null,
        lowPower: camosPlatform.lowPowerOf(d, now),
        location: d.location || null,
        power: { mode: d.power?.mode || 'auto', level: d.power?.level || null },
        sleeping,
        wakeAt: sleeping ? d.wakeAt || null : null,
        nextWakeAt: sleeping || Number(camera.status) !== 1 ? camosPlatform.nextWakeOf(camera, now) : null,
        lastSeenAt: d.lastSeenAt || null,
        liveRequested: !!d.liveRequested,
        locating: !!d.locatingUntil && new Date(d.locatingUntil) > now,
        // false only when the camera reports no cloud live view (shadow live.supported)
        liveSupported: d.shadow?.reported?.live?.supported !== false,
        kvsChannelName: d.kvsChannelName || null,
        thingName: d.thingName || null,
        provisionExpiresAt: d.tokenHash ? null : d.provisionExpiresAt || null
    };
}
const thresholdService = require('../services/thresholdService');
const { viewFilter, viewableCameras, findViewableCamera, findManageableCamera, findOwnedCamera, canManageCamera, isDemoOnly, demoPermsOf, canSeeLocation, canSeeDevice, canWatchLive, canWatchPlayback } = require('../utils/ownership');

// Live view / recorded video refused: a simulated demo camera (no device), or a demo camera seen only
// through demo access whose live view / playback the admin did not open (services/demoView.js)
const DEMO_LIVE_CLOSED = { success: false, code: 'DEMO_READ_ONLY', message: 'Live view of this demo camera is not open to visitors.' };
const DEMO_PLAYBACK_CLOSED = { success: false, code: 'DEMO_READ_ONLY', message: 'Recorded video of this demo camera is not open to visitors.' };
const SIMULATED_NO_LIVE = { success: false, code: 'SIMULATED_CAMERA', message: 'A simulated camera has no live view.' };
// ...or a camera an admin paused (services/fleetService.js)
const CAMERA_DISABLED = { success: false, code: 'CAMERA_DISABLED', message: 'This camera is paused by an administrator.' };
const liveClosed = (camera) => (camera?.adminDisabled?.at ? CAMERA_DISABLED : camera?.simulated ? SIMULATED_NO_LIVE : DEMO_LIVE_CLOSED);
const playbackClosed = (camera) => (camera?.adminDisabled?.at || camera?.simulated ? liveClosed(camera) : DEMO_PLAYBACK_CLOSED);

// What the status of a camera shows a demo visitor without its device details: online, asleep, next wake
const STATUS_WITHOUT_DEVICE = ['platform', 'online', 'sleeping', 'wakeAt', 'nextWakeAt', 'lastSeenAt', 'lastPhotoAt', 'captureIntervalMinutes', 'liveRequested', 'liveSupported'];
function visibleStatus(user, camera, status) {
    if (!status || typeof status !== 'object') return status;
    const shown = canSeeDevice(user, camera) ? { ...status } : Object.fromEntries(STATUS_WITHOUT_DEVICE.filter(k => k in status).map(k => [k, status[k]]));
    if (!canSeeLocation(user, camera)) delete shown.location;
    return shown;
}

// Coordinates in a log line (a GPS fix, a cell estimate), for visitors who may not see the location
const COORDINATE_RE = /-?\d{1,3}\.\d{4,}/g;
const withoutCoordinates = (value) => JSON.parse(JSON.stringify(value).replace(COORDINATE_RE, '…'));

/**
 * Camera as returned to a given user: viewers never see the verification code or the
 * share list; everyone sees whether it is theirs, shared with them, or (admin) someone else's.
 */
function toClientCamera(camera, user) {
    const obj = camera.toObject ? camera.toObject() : { ...camera };
    const owner = obj.userId && typeof obj.userId === 'object' && obj.userId.email ? obj.userId : null;
    const ownerId = String(owner?._id ?? obj.userId ?? '');
    const canManage = canManageCamera(user, { ...obj, userId: ownerId });
    obj.userId = ownerId;
    // Demo viewers (services/demoView.js) never see who owns the camera
    const demoOnly = isDemoOnly(user, { ...obj, userId: ownerId });
    obj.owner = owner && !demoOnly ? { id: ownerId, email: owner.email, name: owner.name || owner.email.split('@')[0] } : null;
    const isOwner = ownerId === String(user.id);
    const sharedWithMe = (obj.sharedWith || []).some(sh => String(sh.userId) === String(user.id));
    // 'admin' = visible only because the viewer is an admin; 'demo' = a read-only demo camera
    obj.access = isOwner ? 'owner' : (sharedWithMe ? 'shared' : (demoOnly ? 'demo' : 'admin'));
    if (demoOnly || obj.simulated) {
        obj.liveOpen = canWatchLive(user, { ...obj, userId: ownerId });
        obj.playbackOpen = canWatchPlayback(user, { ...obj, userId: ownerId });
    }
    // A demo camera: what the admin opened to visitors (services/demoView.js), and nothing else
    const perms = demoPermsOf(user, { ...obj, userId: ownerId });
    if (perms) {
        obj.demo = { ...perms };
        if (!perms.location) {
            obj.latitude = null;
            obj.longitude = null;
            obj.locationAddress = '';
            if (obj.device) delete obj.device.location;
        }
        if (!perms.device) {
            delete obj.deviceVersion;
            delete obj.model;
            delete obj.deviceType;
            delete obj.firmware;
        }
    }
    obj.canManage = canManage;
    obj.cardDueAt = cardDueAt(obj);
    obj.platform = platforms.platformOf(obj);
    // CamOS cameras: what the device reported, never its token hashes or raw shadow; a demo
    // visitor without the device details sees only whether it sleeps and when it wakes
    obj.device = obj.device ? deviceView(obj) : undefined;
    if (obj.device && perms && !perms.device) obj.device = Object.fromEntries(Object.entries(obj.device).filter(([k]) => STATUS_WITHOUT_DEVICE.includes(k)));
    if (obj.device && perms && !perms.location) delete obj.device.location;
    // Paused by an admin: when and why (never who)
    obj.adminDisabled = obj.adminDisabled?.at ? { at: obj.adminDisabled.at, reason: obj.adminDisabled.reason || '' } : undefined;
    if (canManage) {
        obj.sharedWith = (obj.sharedWith || []).map(sh => ({
            email: sh.email,
            userId: sh.userId ? String(sh.userId) : null,
            status: sh.userId ? 'active' : 'pending',
            sharedAt: sh.sharedAt,
            viaFarm: sh.viaFarm ? String(sh.viaFarm) : null,
        // Access through the camera's organization (managed on the organization page)
        viaOrg: sh.viaOrg ? String(sh.viaOrg) : null
        }));
    } else {
        delete obj.sharedWith;
        delete obj.validateCode;
    }
    return obj;
}

// Each viewer's own active stream id per camera ("userId:serial" -> urlId), so switching
// streams only closes that viewer's previous stream, never someone else's
const activeStreamSessions = new Map();
const sessionKey = (userId, deviceSerial) => `${userId}:${deviceSerial}`;

/**
 * Close the caller's previous stream for this camera, if we know it.
 * Never calls EZVIZ without a urlId: that would disable every stream of the device.
 */
async function closePreviousStream(userId, deviceSerial, body) {
    const key = sessionKey(userId, deviceSerial);
    // Only the stream id the server handed to this user: a client-supplied id could stop someone else's stream
    const urlId = activeStreamSessions.get(key) || '';
    activeStreamSessions.delete(key);
    if (!urlId) return null;
    return ezvizService.disableLiveAddress({ deviceSerial, urlId, channelNo: body.channelNo || 1 });
}

/**
 * Get User Camera List
 */
async function getUserCameras(req, res) {
    try {
        const page = parseInt(req.query.page) || null;
        const limit = Math.min(parseInt(req.query.limit) || 0, 100) || null;

        if (page && limit) {
            const skip = (page - 1) * limit;
            const total = await Camera.countDocuments(viewFilter(req.user));
            const cameras = await viewableCameras(req.user).populate('userId', 'email name').sort({ addedAt: -1 }).skip(skip).limit(limit);
            return res.json({
                success: true,
                cameras: cameras.map(c => toClientCamera(c, req.user)),
                pagination: {
                    total,
                    page,
                    limit,
                    totalPages: Math.ceil(total / limit)
                }
            });
        }

        const cameras = await viewableCameras(req.user).populate('userId', 'email name').sort({ addedAt: -1 });
        res.json({ success: true, cameras: cameras.map(c => toClientCamera(c, req.user)), total: cameras.length });
    } catch (error) {
        sendServerError(res, error);
    }
}

/**
 * Add new Camera for User
 */
async function addCamera(req, res) {
    try {
        const userId = req.user.id;
        const { deviceSerial, validateCode, deviceName: customName, trapKind } = req.body;
        if (trapKind !== undefined && !TRAP_KINDS.includes(trapKind)) {
            return res.status(400).json({ success: false, message: `trapKind must be one of ${TRAP_KINDS.join(', ')}.` });
        }
        if (!deviceSerial || !validateCode) {
            return res.status(400).json({ success: false, message: "Missing deviceSerial or validateCode." });
        }
        if (!/^[A-Za-z0-9_-]{3,64}$/.test(deviceSerial) || validateCode.length > 32) {
            return res.status(400).json({ success: false, message: "Invalid serial number or verification code." });
        }
        const platform = req.body.platform === undefined ? 'ezviz' : req.body.platform;
        if (!['ezviz', 'camos'].includes(platform)) {
            return res.status(400).json({ success: false, message: "platform must be 'ezviz' or 'camos'." });
        }
        if (platform === 'camos') return addCamosCamera(req, res, { deviceSerial, validateCode, customName, trapKind });
        if (!/^[A-Za-z0-9]{3,32}$/.test(deviceSerial)) {
            return res.status(400).json({ success: false, message: "Invalid serial number or verification code." });
        }

        // A device can be registered only once. Re-adding your own camera refreshes its code/name;
        // anyone else must ask the owner to share it.
        const existing = await Camera.findOne({ deviceSerial });
        if (existing && String(existing.userId) !== String(userId)) {
            return res.status(409).json({
                success: false,
                code: 'CAMERA_TAKEN',
                message: "This camera is already registered to another account. Ask its owner to share it with you."
            });
        }
        if (existing) {
            existing.validateCode = validateCode.trim();
            if (customName) existing.deviceName = customName.trim();
            await existing.save();
            // Already added: just refresh the code/name (a success, not a client error)
            return res.json({ success: true, message: "Device information updated successfully.", camera: existing });
        }

        // Call EZVIZ API to bind device to APP account
        // check device in ezviz or not
        let deviceInfo = await ezvizService.getDeviceInfo(deviceSerial);
        console.log("deviceInfo", JSON.stringify(deviceInfo));
        if (!deviceInfo) {
            deviceInfo = await ezvizService.addCameraToEzviz(deviceSerial, validateCode);

            // Code 200 is success, 20017 is device already added to account (still valid for DB)
            if (deviceInfo.code !== '200' && deviceInfo.code !== '20017') {
                return res.status(400).json({
                    success: false,
                    message: "EZVIZ Error: " + (deviceInfo.msg || "Could not add device.")
                });
            }
        }
        else{
            //verify validate code
            const liveInfo = await ezvizService.getLiveAddress({deviceSerial, code: validateCode, protocol: 1});
            console.log("liveInfo", JSON.stringify(liveInfo));
            if (!liveInfo?.responseData?.data?.url) {
                return res.status(400).json({
                    success: false,
                    message: "EZVIZ Error: " + (liveInfo.responseData.msg || "Could not add device.")
                });
            }
        }

        let deviceName = customName || ("Camera " + deviceSerial);
        let status = 0;

        if (!customName && deviceInfo && deviceInfo.data && deviceInfo.data.deviceName) {
            deviceName = deviceInfo.data.deviceName;
        }

        const { defaultAlertThreshold } = await require('../services/settingsService').getSettings();
        const newCamera = new Camera({
            userId,
            deviceSerial,
            validateCode: validateCode.trim(),
            deviceName: deviceName.trim(),
            status,
            alertThreshold: defaultAlertThreshold,
            trapKind: trapKind || DEFAULT_TRAP_KIND
        });

        await newCamera.save();
        // Into the owner's organization, so its members see it
        await require('../services/orgService').adoptCamera(req.user, newCamera)
            .catch(err => console.warn('⚠️ Camera not added to an organization:', err.message));
        recordAudit(req, { action: 'camera.added', target: cameraTarget(newCamera) });
        res.json({ success: true, message: "Camera added successfully.", camera: toClientCamera(newCamera, req.user) });

        // Asynchronously sync camera details in the background
        ezvizService.syncCameraStatus(deviceSerial);
    } catch (error) {
        // Lost a race with another registration of the same device
        if (error.code === 11000) {
            return res.status(409).json({
                success: false,
                code: 'CAMERA_TAKEN',
                message: "This camera is already registered to another account. Ask its owner to share it with you."
            });
        }
        sendServerError(res, error);
    }
}

/**
 * A CamOS camera (ESP32 trap on AWS IoT Core): registered from its label (serial + verification
 * code), no cloud call. The answer carries a provisioning token (shown once) the owner gives the
 * camera through its portal; the camera then calls POST /api/device/pair.
 */
async function addCamosCamera(req, res, { deviceSerial, validateCode, customName, trapKind }) {
    const userId = req.user.id;
    // camos-esp32-trap serials are upper case (ESP + MAC), as the camera registers them
    if (/^esp[0-9a-f]{12}$/i.test(String(deviceSerial).trim())) deviceSerial = String(deviceSerial).trim().toUpperCase();
    // A camera that registered itself (public firmware): the serial + verify code claim it, the same as
    // POST /api/cameras/claim, so one "Add camera" dialog covers both kinds of CamOS camera
    const selfRegistered = await Camera.exists({ deviceSerial: String(deviceSerial).trim().toUpperCase(), selfRegistered: true });
    if (selfRegistered) {
        req.body = { serial: deviceSerial, verifyCode: validateCode, trapKind, ...(customName ? { deviceName: customName } : {}) };
        return claimCamera(req, res);
    }
    const existing = await Camera.findOne({ deviceSerial });
    if (existing && String(existing.userId) !== String(userId)) {
        return res.status(409).json({ success: false, code: 'CAMERA_TAKEN', message: "This camera is already registered to another account. Ask its owner to share it with you." });
    }
    // The serial registry: a registered serial needs its label code, a blocked one is refused, and in strict
    // mode an unregistered serial joins no account (wrong codes count toward the same lock as /claim)
    const registration = require('../services/registrationService');
    const registryKey = String(deviceSerial).trim().toUpperCase();
    if (registration.claimLocked(registryKey)) {
        return res.status(429).json({ success: false, code: 'LOCKED', message: 'Too many wrong codes for this serial. Try again later.' });
    }
    const refused = await require('../services/registryService').checkClaim(registryKey, validateCode);
    if (refused) {
        if (refused.wrongCode) registration.recordClaimFailure(registryKey);
        return res.status(refused.status).json(refused.body);
    }
    let camera = existing;
    if (camera) {
        if (camera.platform !== 'camos') return res.status(409).json({ success: false, message: "This serial is registered as an EZVIZ camera." });
        camera.validateCode = validateCode.trim();
        if (customName) camera.deviceName = customName.trim();
        await camera.save();
    } else {
        const { defaultAlertThreshold } = await require('../services/settingsService').getSettings();
        camera = new Camera({
            userId,
            deviceSerial,
            platform: 'camos',
            validateCode: validateCode.trim(),
            deviceName: (customName || `Trap ${deviceSerial}`).trim(),
            status: 0,
            alertThreshold: defaultAlertThreshold,
            trapKind: trapKind || DEFAULT_TRAP_KIND,
            device: { thingName: deviceSerial }
        });
        await camera.save();
        await require('../services/orgService').adoptCamera(req.user, camera)
            .catch(err => console.warn('⚠️ Camera not added to an organization:', err.message));
        recordAudit(req, { action: 'camera.added', target: cameraTarget(camera), details: { platform: 'camos' } });
        await require('../services/registryService').markClaimed(registryKey, userId);
    }
    // camos-esp32-trap cameras (serial ESP + MAC) register themselves: no token to type in, the camera joins this
    // account when it registers with the same verify code (registrationService.registerForOwner)
    if (/^ESP[0-9A-F]{12}$/.test(String(deviceSerial).trim().toUpperCase())) {
        const fresh = await Camera.findById(camera._id);
        return res.json({
            success: true,
            pending: true,
            message: "Camera added. It joins your account by itself when it connects.",
            camera: toClientCamera(fresh, req.user)
        });
    }
    const provisioning = await deviceService.issueProvisionToken(camera);
    const fresh = await Camera.findById(camera._id);
    res.json({
        success: true,
        message: existing ? "Device information updated successfully." : "Camera added successfully.",
        camera: toClientCamera(fresh, req.user),
        provisioning: provisioningView(fresh, provisioning)
    });
}

/** What the owner types into the camera's portal (or scans): token, API base, IoT endpoint, QR text. */
function provisioningView(camera, { provisionToken, expiresAt, pairUrl, apiBase }) {
    const { IOT_ENDPOINT, AWS_REGION } = require('../config/env');
    const esc = (v) => String(v || '').replace(/([\\;:])/g, '\\$1');
    return {
        provisionToken,
        expiresAt,
        pairUrl,
        apiBase,
        iotEndpoint: IOT_ENDPOINT || null,
        kvs: { region: AWS_REGION, channelName: camera.device?.kvsChannelName || `cam-${camera.deviceSerial}` },
        // CamOS protocol v1 section 12.2 network QR (Wi-Fi fields are added by the app when scanned)
        qr: `CAMOS:1;K:${esc(provisionToken)};E:${esc(IOT_ENDPOINT)};U:${esc(apiBase)};;`
    };
}

/**
 * POST /api/user/camera/provision { deviceSerial }: a new provisioning token for a CamOS camera
 * (the old one is replaced; a paired camera keeps its device token until it pairs again).
 */
async function provisionCamera(req, res) {
    const { deviceSerial } = req.body;
    if (!deviceSerial) return res.status(400).json({ success: false, message: "Missing deviceSerial." });
    try {
        const camera = await findManageableCamera(req.user, deviceSerial);
        if (!camera) return res.status(404).json({ success: false, message: "Device not found or permission denied." });
        if (camera.platform !== 'camos') return res.status(400).json({ success: false, message: "Only CamOS cameras are provisioned this way." });
        const provisioning = await deviceService.issueProvisionToken(camera);
        recordAudit(req, { action: 'camera.updated', target: cameraTarget(camera), details: { provisioned: true } });
        const fresh = await Camera.findById(camera._id);
        res.json({ success: true, provisioning: provisioningView(fresh, provisioning) });
    } catch (err) {
        sendServerError(res, err, { context: 'Camera provisioning' });
    }
}

/**
 * GET /api/cameras/:serial/live: the live session of a camera through its platform. EZVIZ
 * cameras answer with the existing live URL shape (POST /api/live); CamOS/KVS cameras with the
 * KVS viewer config (CONTRACTS section 4) and, for a camera on battery, a live request for its
 * next wake.
 */
async function getLive(req, res) {
    const deviceSerial = String(req.params.serial || '');
    try {
        const camera = await findViewableCamera(req.user, deviceSerial);
        if (!camera) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: "Camera not found or permission denied." });
        if (!canWatchLive(req.user, camera)) return res.status(403).json(liveClosed(camera));
        if (platforms.platformOf(camera) === 'ezviz') {
            req.body = { ...(req.body || {}), deviceSerial };
            return getLiveStream(req, res);
        }
        const minutes = await require('../services/registrationService').liveMinutes(camera, req.user, 5);
        const session = await platforms.get(camera).liveSession(deviceSerial, { user: req.user, minutes });
        if (session?.camera) session.camera = visibleStatus(req.user, camera, session.camera);
        res.setHeader('Cache-Control', 'no-store');
        // The viewer needs the real KVS channel (its name holds the serial), even when the serial is hidden
        res.locals.demoRawSerial = true;
        res.json({ success: true, ...session });
    } catch (err) {
        if (err.code === 'LIVE_NOT_CONFIGURED') return res.status(503).json({ success: false, code: err.code, message: err.message });
        sendServerError(res, err, { context: 'Live session' });
    }
}

/** POST /api/cameras/:serial/live/request { minutes }: ask a sleeping CamOS camera for live view at its next wake. */
async function requestLive(req, res) {
    const deviceSerial = String(req.params.serial || '');
    const asked = Number.isInteger(req.body?.minutes) ? Math.min(Math.max(req.body.minutes, 1), 30) : 5;
    try {
        const camera = await findViewableCamera(req.user, deviceSerial);
        if (!camera) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: "Camera not found or permission denied." });
        if (!canWatchLive(req.user, camera)) return res.status(403).json(liveClosed(camera));
        if (platforms.platformOf(camera) !== 'camos') return res.status(400).json({ success: false, message: "Only CamOS cameras take a live request." });
        // Demo cameras: DEMO_LIVE_MINUTES (5) per request
        const minutes = await require('../services/registrationService').liveMinutes(camera, req.user, asked);
        const result = await camosPlatform.requestLive(deviceSerial, { minutes });
        recordAudit(req, { action: 'camera.updated', target: cameraTarget(camera), details: { liveRequested: true, minutes } });
        res.json({ success: true, ...result });
    } catch (err) {
        sendServerError(res, err, { context: 'Live request' });
    }
}

/**
 * POST /api/cameras/claim { serial, verifyCode, farmId?, trapKind?, captureIntervalMinutes?, deviceName? }:
 * take over a self-registered camera (flybot-aws CONTRACTS 2a.4). A wrong code answers 404 without
 * saying whether the serial exists; 5 wrong codes lock the serial for an hour.
 */
async function claimCamera(req, res) {
    try {
        const result = await require('../services/registrationService').claim(req.user, req.body);
        if (result.body?.retryAfter) res.setHeader('Retry-After', String(result.body.retryAfter));
        if (result.status === 200 && !result.body.alreadyClaimed) {
            recordAudit(req, { action: 'camera.claimed', target: { type: 'camera', id: result.body.camera.deviceSerial, label: result.body.camera.deviceName }, details: { trapKind: result.body.camera.trapKind, farmId: result.body.camera.farmId } });
        }
        res.status(result.status).json(result.body);
    } catch (err) {
        sendServerError(res, err, { context: 'Claim camera' });
    }
}

/** GET /api/cameras/:serial/playback?from&to: SD records (EZVIZ) or the snapshot timeline (CamOS). */
async function getPlayback(req, res) {
    const deviceSerial = String(req.params.serial || '');
    try {
        const camera = await findViewableCamera(req.user, deviceSerial);
        if (!camera) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: "Camera not found or permission denied." });
        // EZVIZ playback reads the camera's SD card; CamOS playback is the photo timeline
        if (platforms.platformOf(camera) === 'ezviz' && !canWatchPlayback(req.user, camera)) return res.status(403).json(playbackClosed(camera));
        const { from, to } = req.query;
        const result = await platforms.get(camera).playback(deviceSerial, { from: from ? String(from) : undefined, to: to ? String(to) : undefined });
        res.json({ success: true, ...result });
    } catch (err) {
        sendServerError(res, err, { context: 'Playback' });
    }
}

/** A camos-esp32-trap camera (serial ESP + MAC): the one whose remote settings services/camosSettings.js lists. */
const isEsp32Trap = (camera) => platforms.platformOf(camera) === 'camos' && /^ESP[0-9A-F]{12}$/.test(String(camera.deviceSerial || ''));

/** GET /api/cameras/:serial/device-settings: the camera's settings, applied (reported) and asked for (desired). */
async function getDeviceSettings(req, res) {
    const deviceSerial = String(req.params.serial || '');
    try {
        const camera = await findManageableCamera(req.user, deviceSerial);
        if (!camera) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: "Camera not found or permission denied." });
        if (!isEsp32Trap(camera)) return res.status(400).json({ success: false, code: 'NOT_SUPPORTED', message: "This camera has no remote settings." });
        res.setHeader('Cache-Control', 'no-store');
        res.json({ success: true, ...require('../services/camosSettings').view(camera) });
    } catch (err) {
        sendServerError(res, err, { context: 'Camera settings' });
    }
}

/**
 * PUT /api/cameras/:serial/device-settings { changes: { "capture.intervalMin": 30, ... } }: checked against the
 * firmware's key list, then sent as desired settings (the camera applies them now or at its next connect).
 */
async function updateDeviceSettings(req, res) {
    const deviceSerial = String(req.params.serial || '');
    try {
        const camera = await findManageableCamera(req.user, deviceSerial);
        if (!camera) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: "Camera not found or permission denied." });
        if (!isEsp32Trap(camera)) return res.status(400).json({ success: false, code: 'NOT_SUPPORTED', message: "This camera has no remote settings." });
        const settings = require('../services/camosSettings');
        const { errors, desired } = settings.toDesired(req.body?.changes);
        if (errors.length) return res.status(400).json({ success: false, code: 'BAD_SETTINGS', message: "Some settings are not valid.", errors });
        await require('../platforms/camos').updateDesired(deviceSerial, desired);
        // The capture interval is also FlyBot's own schedule field
        if (Number.isInteger(desired.capture?.intervalMin)) {
            await Camera.updateMany({ deviceSerial }, { $set: { captureIntervalMinutes: desired.capture.intervalMin } });
        }
        recordAudit(req, { action: 'camera.updated', target: cameraTarget(camera), details: { settings: Object.keys(req.body.changes) } });
        const fresh = await Camera.findOne({ deviceSerial }).lean();
        res.json({ success: true, ...settings.view(fresh) });
    } catch (err) {
        sendServerError(res, err, { context: 'Camera settings' });
    }
}

// What the camera's web console can do remotely, as camos-esp32-trap RPCs (protocol v1): refresh its state, take a
// GPS fix, restart, change the Wi-Fi or the 4G APN (stored now, used from the next boot). No factory reset from
// here: it erases the camera's registration, and a camera on 4G in a field would not come back without a person.
const SSID_RE = /^[\x20-\x7e]{1,32}$/;
const APN_RE = /^[A-Za-z0-9._-]{1,63}$/;
function deviceActionRequest(body) {
    const action = String(body?.action || '');
    if (action === 'refresh') return { method: 'state', params: {} };
    if (action === 'locate') return { method: 'gps.fix', params: { timeoutS: camosPlatform.GPS_FIX_S }, noWait: true };
    if (action === 'restart') return { method: 'reboot', params: {} };
    if (action === 'wifi') {
        const ssid = typeof body.ssid === 'string' ? body.ssid : '';
        const password = typeof body.password === 'string' ? body.password : '';
        if (!SSID_RE.test(ssid)) return { error: 'BAD_SSID' };
        if (password && (password.length < 8 || password.length > 63)) return { error: 'BAD_PASSWORD' };
        return { method: 'net.set', params: { wifi: { ssid, password } } };
    }
    if (action === 'apn') {
        const apn = typeof body.apn === 'string' ? body.apn.trim() : '';
        if (!APN_RE.test(apn)) return { error: 'BAD_APN' };
        return { method: 'net.set', params: { cellular: { apn } } };
    }
    return { error: 'BAD_ACTION' };
}

/**
 * POST /api/cameras/:serial/device-action { action: refresh | locate | restart | wifi {ssid, password} | apn {apn} }:
 * one RPC to a camos-esp32-trap camera that is online and awake. The audit keeps the action, never a password.
 * A GPS fix takes up to 5 minutes: it is sent without waiting, and the location comes with the camera's answer. The
 * camera turns its 4G radio off meanwhile, so it is marked locating: its disconnect is not an outage. Asked for while
 * the camera is offline or asleep, it waits for the camera's next connection (202, queued).
 */
async function deviceAction(req, res) {
    const deviceSerial = String(req.params.serial || '');
    try {
        const camera = await findManageableCamera(req.user, deviceSerial);
        if (!camera) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: "Camera not found or permission denied." });
        if (!isEsp32Trap(camera)) return res.status(400).json({ success: false, code: 'NOT_SUPPORTED', message: "This camera has no remote actions." });
        const request = deviceActionRequest(req.body);
        if (request.error) return res.status(400).json({ success: false, code: request.error, message: "This action or its value is not valid." });
        const camos = require('../platforms/camos');
        const status = await camos.getStatus(deviceSerial);
        const away = !status?.online || status.sleeping;
        // A GPS fix: queued while the camera is away (sent at its next connection), else sent without waiting
        if (request.method === 'gps.fix') {
            if (away) await camos.queueLocate(deviceSerial);
            const sent = away ? { ok: true } : await camos.startLocate(deviceSerial);
            recordAudit(req, { action: 'camera.action', target: cameraTarget(camera), details: { action: 'locate', ok: sent.ok, ...(away ? { queued: true } : {}) } });
            if (!sent.ok) return res.status(502).json({ success: false, code: String(sent.error).slice(0, 40), message: "The camera did not do it." });
            return res.status(away ? 202 : 200).json({ success: true, action: 'locate', queued: away, result: { pending: true } });
        }
        if (away) return res.status(409).json({ success: false, code: 'OFFLINE', message: "The camera is offline or asleep: try again when it is online." });
        const answer = request.noWait
            ? await camos.rpc(deviceSerial, request.method, request.params).then((r) => ({ ok: true, id: r.id, result: { pending: true } }), err => ({ ok: false, error: err.code || 'NOT_SENT' }))
            : await camos.rpc(deviceSerial, request.method, request.params, { wait: true, timeoutMs: 15000 })
                .catch(err => ({ ok: false, error: err.code || 'TIMEOUT' }));
        recordAudit(req, { action: 'camera.action', target: cameraTarget(camera), details: { action: String(req.body.action), ok: answer?.ok !== false } });
        if (answer?.ok === false) return res.status(502).json({ success: false, code: String(answer.error?.code || answer.error || 'CAMERA_ERROR').slice(0, 40), message: "The camera did not do it." });
        res.json({ success: true, action: String(req.body.action), result: answer?.result || null });
    } catch (err) {
        sendServerError(res, err, { context: 'Camera action' });
    }
}

/** GET /api/cameras/:serial/status: online, power mode, sleeping and next wake (platform-aware). */
async function getCameraStatus(req, res) {
    const deviceSerial = String(req.params.serial || '');
    try {
        const camera = await findViewableCamera(req.user, deviceSerial);
        if (!camera) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: "Camera not found or permission denied." });
        const status = visibleStatus(req.user, camera, await platforms.get(camera).getStatus(deviceSerial));
        res.json({ success: true, status });
    } catch (err) {
        sendServerError(res, err, { context: 'Camera status' });
    }
}

/**
 * Delete camera
 */
async function deleteCamera(req, res) {
    const userId = req.user.id;
    const { deviceSerial } = req.body;
    if (!deviceSerial) return res.status(400).json({ success: false, message: "Missing deviceSerial." });
    try {
        const camera = await findOwnedCamera(req.user, deviceSerial);
        // A self-registered camera: its certificate, thing and channel go too, so the device can
        // register again from scratch (the owner's "reset", CONTRACTS 2a.2)
        if (camera?.selfRegistered) {
            const { errors } = await require('../services/registrationService').teardownAws(camera.toObject());
            if (errors.length) console.warn(`⚠️ AWS cleanup of ${deviceSerial} incomplete: ${errors.join('; ')}`);
        }
        const deleted = camera ? await Camera.findOneAndDelete({ _id: camera._id }) : null;
        if (!deleted) {
            return res.status(404).json({ success: false, message: "Device not found or permission denied." });
        }
        recordAudit(req, {
            action: 'camera.deleted',
            target: cameraTarget(deleted),
            details: { owner: String(deleted.userId) === String(req.user.id) ? 'self' : String(deleted.userId), sharedWith: (deleted.sharedWith || []).length }
        });
        res.json({ success: true, message: "Device removed successfully." });
    } catch (err) {
        sendServerError(res, err);
    }
}

/**
 * Edit camera (device name, validate code)
 */
async function updateCamera(req, res) {
    const userId = req.user.id;
    const { deviceSerial, deviceName, validateCode, alertThreshold, captureIntervalMinutes, captureDaytimeOnly, cardReminderDays, trapKind } = req.body;
    if (trapKind !== undefined && !TRAP_KINDS.includes(trapKind)) {
        return res.status(400).json({ success: false, message: `trapKind must be one of ${TRAP_KINDS.join(', ')}.` });
    }
    if (!deviceSerial) return res.status(400).json({ success: false, message: "Missing deviceSerial." });
    if (typeof alertThreshold !== 'undefined' &&
        (!Number.isInteger(alertThreshold) || alertThreshold < 1 || alertThreshold > 10000)) {
        return res.status(400).json({ success: false, message: "alertThreshold must be a whole number from 1 to 10000." });
    }
    if (typeof captureIntervalMinutes !== 'undefined' && !CAPTURE_INTERVALS.includes(captureIntervalMinutes)) {
        return res.status(400).json({ success: false, message: `captureIntervalMinutes must be one of ${CAPTURE_INTERVALS.join(', ')}.` });
    }
    if (typeof captureDaytimeOnly !== 'undefined' && typeof captureDaytimeOnly !== 'boolean') {
        return res.status(400).json({ success: false, message: "captureDaytimeOnly must be true or false." });
    }
    if (typeof cardReminderDays !== 'undefined' && !CARD_REMINDER_DAYS.includes(cardReminderDays)) {
        return res.status(400).json({ success: false, message: `cardReminderDays must be one of ${CARD_REMINDER_DAYS.join(', ')}.` });
    }
    try {
        const camera = await findManageableCamera(req.user, deviceSerial);
        if (!camera) {
            return res.status(404).json({ success: false, message: "Device not found or permission denied." });
        }
        const AUDITED_FIELDS = ['deviceName', 'validateCode', 'alertThreshold', 'captureIntervalMinutes', 'captureDaytimeOnly', 'cardReminderDays', 'trapKind'];
        const before = Object.fromEntries(AUDITED_FIELDS.map(field => [field, camera[field]]));
        if (typeof deviceName !== 'undefined') {
            camera.deviceName = deviceName.trim();
        }
        if (typeof validateCode !== 'undefined') {
            camera.validateCode = validateCode.trim();
        }
        if (typeof alertThreshold !== 'undefined') {
            camera.alertThreshold = alertThreshold;
        }
        if (typeof captureIntervalMinutes !== 'undefined') {
            camera.captureIntervalMinutes = captureIntervalMinutes;
        }
        if (typeof captureDaytimeOnly !== 'undefined') {
            camera.captureDaytimeOnly = captureDaytimeOnly;
        }
        if (typeof trapKind !== 'undefined') camera.trapKind = trapKind;
        if (typeof cardReminderDays !== 'undefined') {
            camera.cardReminderDays = cardReminderDays;
        }
        const changed = AUDITED_FIELDS.filter(field => camera[field] !== before[field]);
        await camera.save();
        if (changed.length) {
            // The verification code is a secret: record that it changed, not its value
            const details = { fields: changed };
            for (const field of ['deviceName', 'alertThreshold', 'captureIntervalMinutes', 'captureDaytimeOnly', 'cardReminderDays', 'trapKind']) {
                if (changed.includes(field)) details[field] = camera[field];
            }
            recordAudit(req, { action: 'camera.updated', target: cameraTarget(camera), details });
        }
        res.json({ success: true, message: "Camera updated successfully.", camera: toClientCamera(camera, req.user) });
    } catch (err) {
        sendServerError(res, err);
    }
}

/**
 * Update Camera GPS Location and Orchard Plot Address
 */
async function updateCameraLocation(req, res) {
    const userId = req.user.id;
    const { deviceSerial, latitude, longitude, locationAddress, trapType, trapKind, cropType } = req.body;
    if (!deviceSerial) {
        return res.status(400).json({ success: false, message: "Missing deviceSerial." });
    }
    if (trapKind !== undefined && !TRAP_KINDS.includes(trapKind)) {
        return res.status(400).json({ success: false, message: `trapKind must be one of ${TRAP_KINDS.join(', ')}.` });
    }

    try {
        const camera = await findManageableCamera(req.user, deviceSerial);
        if (!camera) {
            return res.status(404).json({ success: false, message: "Camera not found or permission denied." });
        }

        const kindBefore = camera.trapKind;
        const placedBefore = [camera.latitude, camera.longitude];
        if (latitude !== undefined) camera.latitude = Number(latitude);
        if (longitude !== undefined) camera.longitude = Number(longitude);
        // Moved by hand: a GPS fix from the camera no longer moves it; pinned: false hands the point back to the GPS
        if (camera.latitude !== placedBefore[0] || camera.longitude !== placedBefore[1]) camera.locationPinned = true;
        if (req.body.pinned === false) {
            camera.locationPinned = false;
            const fix = camera.device?.location;
            if (fix && Number.isFinite(fix.lat) && Number.isFinite(fix.lng)) { camera.latitude = fix.lat; camera.longitude = fix.lng; }
        }
        if (locationAddress !== undefined) camera.locationAddress = locationAddress;
        if (trapType !== undefined) camera.trapType = trapType;
        if (trapKind !== undefined) camera.trapKind = trapKind;
        if (cropType !== undefined) camera.cropType = cropType;

        await camera.save();
        if (camera.trapKind !== kindBefore) {
            recordAudit(req, { action: 'camera.updated', target: cameraTarget(camera), details: { fields: ['trapKind'], trapKind: camera.trapKind } });
        }
        res.json({ success: true, message: "Camera location updated successfully.", camera: toClientCamera(camera, req.user) });
    } catch (err) {
        sendServerError(res, err);
    }
}

/**
 * Update Verification Code for Camera
 */
async function updateCameraCode(req, res) {
    const userId = req.user.id;
    const { deviceSerial, validateCode } = req.body;
    if (!deviceSerial || !validateCode) {
        return res.status(400).json({ success: false, message: "Missing deviceSerial or validateCode." });
    }
    try {
        const cleanCode = validateCode.trim();
        const camera = await findManageableCamera(req.user, deviceSerial);
        if (!camera) {
            return res.status(404).json({ success: false, message: "Device not found or permission denied." });
        }
        camera.validateCode = cleanCode;
        await camera.save();
        recordAudit(req, { action: 'camera.updated', target: cameraTarget(camera), details: { fields: ['validateCode'] } });
        res.json({ success: true, message: "Verification code updated successfully.", camera: toClientCamera(camera, req.user) });
    } catch (err) {
        sendServerError(res, err);
    }
}

/**
 * Get live stream link (EZOPEN / HLS)
 */
async function getLiveStream(req, res) {
    const userId = req.user.id;
    const { deviceSerial } = req.body;
    if (!deviceSerial) return res.status(400).json({ code: "400", msg: "Missing Serial Number." });

    try {
        const camera = await findViewableCamera(req.user, deviceSerial);
        if (!camera) {
            return res.status(403).json({ code: "403", msg: "You do not have permission to access this camera." });
        }
        if (!canWatchLive(req.user, camera)) return res.status(403).json({ code: "403", msg: liveClosed(camera).message });
        // The EZVIZ player's address holds the real serial, even when it is hidden from a demo visitor
        res.locals.demoRawSerial = true;

        let code = (camera.validateCode || '').trim();
        // check camera setting first

        // Invalidate / disable old active stream using urlId from client or server cache
        await closePreviousStream(userId, deviceSerial, req.body);

        const isEncrypt = (camera.isEncrypt === 1);
        console.log("isEncrypt: ", isEncrypt);
        // Protocol 1: ezopen (standard for multi-camera playback), Protocol 2: HLS
        const reqProtocol = req.body.protocol || req.query.protocol;
        const protocol = isEncrypt ? 1 : 2;
        // For ezopen, use quality 1 (HD)
        const streamQuality = protocol === 2 ? 1 : (Number(req.body.quality) === 2 ? 2 : 1);
        console.log("protocol:", protocol, "streamQuality:", streamQuality);
        let responseData, token, areaDomain;
        let result = await ezvizService.getLiveAddress({
            deviceSerial,
            code,
            protocol: protocol,
            quality: streamQuality,
        });

        if (result && result.responseData) {
            responseData = result.responseData;
            token = result.token;
            areaDomain = result.areaDomain;
        }


        if (responseData && responseData.code == '60019') {
            await Camera.updateMany({ deviceSerial }, { $set: { isEncrypt: 1 } });
            result = await ezvizService.getLiveAddress({
                deviceSerial,
                code,
                protocol: 1, // 1: ezopen
                quality: 1, // Use 1 (HD) for ezopen
            });

            if (!result) {
                return res.status(500).json({ code: "500", msg: "EZVIZ API error" });
            }
            responseData = result.responseData;
            token = result.token;
            areaDomain = result.areaDomain;
        }

        if (!responseData) {
            return res.status(500).json({ code: "500", msg: "EZVIZ API error" });
        }

        if (responseData.code == '200') {
            const liveUrl = responseData.data?.url || '';
            const isEncrypted = liveUrl.includes('@') ? 1 : 0;

            await Camera.updateMany({ deviceSerial }, { $set: { isEncrypt: isEncrypted } });

            if (responseData.data?.id) {
                activeStreamSessions.set(sessionKey(userId, deviceSerial), responseData.data.id);
            }

            responseData.data.accessToken = await playerToken(req, token);
            if (!responseData.data.accessToken) return res.status(503).json(PLAYER_UNAVAILABLE);
            responseData.data.areaDomain = areaDomain;
            responseData.data.isEncrypt = isEncrypted;
            responseData.data.validateCode = isEncrypted ? code : '';
        } else if (responseData.code == '60019') {
            return res.json({
                code: "60019",
                msg: "Camera video encryption is enabled. Please enter verification code to decrypt.",
                data: {
                    isEncrypt: 1,
                    deviceSerial: deviceSerial
                }
            });
        }

        res.json(responseData);
    } catch (error) {
        console.log(error);
        sendServerError(res, error, { format: 'ezviz' });
    }
}

const PLAYER_UNAVAILABLE = { code: "503", msg: "Video is temporarily unavailable. Please try again later." };

/**
 * The EZVIZ token for this viewer's player: a sub-account token limited to their cameras when
 * EZVIZ_RAM_TOKENS is on (null if that fails; never the app token instead).
 */
async function playerToken(req, appToken) {
    try {
        return await ezvizRamService.playerTokenFor(req.user, appToken);
    } catch (err) {
        console.error('❌ EZVIZ sub-account token failed:', err.message);
        return null;
    }
}

/**
 * Get video playback record list (API v3 DAS)
 */
async function getRecords(req, res) {
    const userId = req.user.id;
    const { deviceSerial, startTime, endTime } = req.body;
    if (!deviceSerial) return res.status(400).json({ code: "400", msg: "Missing Serial Number." });

    try {
        const camera = await findViewableCamera(req.user, deviceSerial);
        if (!camera) {
            return res.status(403).json({ code: "403", msg: "You do not have permission to access this camera." });
        }
        if (!canWatchPlayback(req.user, camera)) return res.status(403).json({ code: "403", msg: playbackClosed(camera).message });

        const data = await ezvizService.getLocalRecords({ deviceSerial, startTime, endTime });
        res.json(data);
    } catch (error) {
        sendServerError(res, error, { format: 'ezviz' });
    }
}

/**
 * Get playback stream link (m3u8 or ezopen)
 */
async function getPlaybackStream(req, res) {
    const userId = req.user.id;
    const { deviceSerial, startTime, stopTime } = req.body;
    if (!deviceSerial) return res.status(400).json({ code: "400", msg: "Missing Serial Number." });

    try {
        const camera = await findViewableCamera(req.user, deviceSerial);
        if (!camera) {
            return res.status(403).json({ code: "403", msg: "You do not have permission to access this camera." });
        }
        if (!canWatchPlayback(req.user, camera)) return res.status(403).json({ code: "403", msg: playbackClosed(camera).message });
        // The EZVIZ player's address holds the real serial, even when it is hidden from a demo visitor
        res.locals.demoRawSerial = true;

        console.log("startTime: ", startTime, "stopTime: ", stopTime);

        // Invalidate / disable old active stream with urlId
        await closePreviousStream(userId, deviceSerial, req.body);

        const { responseData, token, areaDomain } = await ezvizService.getPlaybackAddress({
            deviceSerial,
            code: camera.validateCode,
            startTime,
            stopTime,
            protocol: 1 // ezopen (standard playback for local SD card recording)
        });


        if (responseData.code == '200') {
            if (responseData.data?.id) {
                activeStreamSessions.set(sessionKey(userId, deviceSerial), responseData.data.id);
            }
            responseData.data.accessToken = await playerToken(req, token);
            if (!responseData.data.accessToken) return res.status(503).json(PLAYER_UNAVAILABLE);
            responseData.data.areaDomain = areaDomain;
            responseData.data.validateCode = camera.validateCode;
        }
        res.json(responseData);
    } catch (error) {
        sendServerError(res, error, { format: 'ezviz' });
    }
}

/**
 * Disable active stream upon manual request
 */
async function disableStream(req, res) {
    const userId = req.user.id;
    const { deviceSerial, channelNo, urlId, id } = req.body;
    if (!deviceSerial) return res.status(400).json({ code: "400", msg: "Missing Serial Number." });

    try {
        const camera = await findViewableCamera(req.user, deviceSerial);
        if (!camera) {
            return res.status(403).json({ code: "403", msg: "You do not have permission to access this camera." });
        }

        const result = await closePreviousStream(userId, deviceSerial, { urlId, id, channelNo });
        res.json(result || { code: "200", msg: "Stream disabled successfully" });
    } catch (error) {
        sendServerError(res, error, { format: 'ezviz' });
    }
}

// ---------- Remote console log (services/cameraLogService.js) ----------

/**
 * Admins, and owners / managers of the camera (never people it is shared with or support); with
 * `read`, also demo visitors of a shared camera whose device details the admin opened (they read
 * the log, never start, stop or watch it). Returns the camera (lean) or null after answering 404.
 */
async function logCamera(req, res, { read = false } = {}) {
    const serial = String(req.params.serial || '');
    let camera = await findManageableCamera(req.user, serial);
    if (camera && isDemoOnly(req.user, camera)) camera = null;
    if (!camera && read) {
        const seen = await findViewableCamera(req.user, serial);
        if (seen && !seen.simulated && isDemoOnly(req.user, seen) && canSeeDevice(req.user, seen)) camera = seen;
    }
    if (!camera) {
        res.status(404).json({ success: false, code: 'NOT_FOUND', message: "Camera not found or permission denied." });
        return null;
    }
    return camera.toObject ? camera.toObject() : camera;
}

// A demo visitor who may not see the camera's location reads its log without coordinates
const logFor = (req, camera, value) => (canSeeLocation(req.user, camera) ? value : withoutCoordinates(value));

async function getCameraLog(req, res) {
    try {
        const camera = await logCamera(req, res, { read: true });
        if (!camera) return;
        res.setHeader('Cache-Control', 'no-store');
        res.json(logFor(req, camera, await require('../services/cameraLogService').list(camera, req.query)));
    } catch (err) {
        sendServerError(res, err, { context: 'Camera log' });
    }
}

async function downloadCameraLog(req, res) {
    try {
        const camera = await logCamera(req, res, { read: true });
        if (!camera) return;
        const body = logFor(req, camera, await require('../services/cameraLogService').text(camera));
        const name = `${camera.deviceSerial}-log-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.txt`;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.send(body);
    } catch (err) {
        sendServerError(res, err, { context: 'Camera log download' });
    }
}

async function getCameraCrashes(req, res) {
    try {
        const camera = await logCamera(req, res, { read: true });
        if (!camera) return;
        res.json(logFor(req, camera, await require('../services/cameraLogService').crashes(camera)));
    } catch (err) {
        sendServerError(res, err, { context: 'Camera crashes' });
    }
}

async function startCameraLog(req, res) {
    try {
        const camera = await logCamera(req, res);
        if (!camera) return;
        const level = req.body?.level === undefined ? 'info' : req.body.level;
        const minutes = req.body?.minutes === undefined ? 15 : req.body.minutes;
        const result = await require('../services/cameraLogService').start(camera, { level, minutes });
        if (result.status === 200) {
            require('../services/cameraLogService').watch(camera.deviceSerial, req.user.id);
            recordAudit(req, { action: 'camera.log_started', target: cameraTarget(camera), details: { level, minutes } });
        }
        res.status(result.status).json(result.body);
    } catch (err) {
        sendServerError(res, err, { context: 'Camera log start' });
    }
}

async function stopCameraLog(req, res) {
    try {
        const camera = await logCamera(req, res);
        if (!camera) return;
        const result = await require('../services/cameraLogService').stop(camera);
        if (result.status === 200) recordAudit(req, { action: 'camera.log_stopped', target: cameraTarget(camera) });
        res.status(result.status).json(result.body);
    } catch (err) {
        sendServerError(res, err, { context: 'Camera log stop' });
    }
}

/** POST /api/cameras/:serial/log/watch { watching }: new lines go to this person's notification stream for 90 s. */
async function watchCameraLog(req, res) {
    try {
        const camera = await logCamera(req, res);
        if (!camera) return;
        const logs = require('../services/cameraLogService');
        if (req.body?.watching === false) logs.unwatch(camera.deviceSerial, req.user.id);
        else logs.watch(camera.deviceSerial, req.user.id);
        res.json({ success: true, state: logs.stateOf(camera) });
    } catch (err) {
        sendServerError(res, err, { context: 'Camera log watch' });
    }
}

// ---------- Firmware (services/firmwareService.js) ----------

const languageOf = (req) => (String(req.get('X-Language') || req.user?.language || 'en').toLowerCase().startsWith('vi') ? 'vi' : 'en');

/** GET /api/cameras/:serial/firmware: running and latest version, release notes, the last update. */
async function getFirmware(req, res) {
    try {
        const camera = await findViewableCamera(req.user, String(req.params.serial || '')).lean();
        // A demo camera whose device details are closed to visitors: not even its firmware version
        if (!camera || !canSeeDevice(req.user, camera)) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: "Camera not found or permission denied." });
        const canManage = canManageCamera(req.user, camera) && !isDemoOnly(req.user, camera);
        res.json(await require('../services/firmwareService').statusFor(camera, { canManage, language: languageOf(req) }));
    } catch (err) {
        sendServerError(res, err, { context: 'Firmware status' });
    }
}

/** POST /api/cameras/:serial/firmware/check: read the version again (EZVIZ: from the EZVIZ cloud). */
async function checkFirmware(req, res) {
    try {
        const serial = String(req.params.serial || '');
        let camera = await findViewableCamera(req.user, serial).lean();
        if (!camera || !canSeeDevice(req.user, camera)) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: "Camera not found or permission denied." });
        if (platforms.platformOf(camera) === 'ezviz' && !camera.simulated) {
            await ezvizService.syncCameraStatus(serial).catch(err => console.warn(`⚠️ EZVIZ version check ${serial}: ${err.message}`));
            camera = await findViewableCamera(req.user, serial).lean();
        }
        const canManage = canManageCamera(req.user, camera) && !isDemoOnly(req.user, camera);
        res.json({ ...(await require('../services/firmwareService').statusFor(camera, { canManage, language: languageOf(req) })), checkedAt: new Date() });
    } catch (err) {
        sendServerError(res, err, { context: 'Firmware check' });
    }
}

/** POST /api/cameras/:serial/firmware/update { confirm: true }: install the current release (owners and managers). */
async function updateFirmware(req, res) {
    try {
        if (req.body?.confirm !== true) return res.status(400).json({ success: false, code: 'CONFIRM', message: 'Confirm the update first.' });
        const camera = await findManageableCamera(req.user, String(req.params.serial || ''));
        if (!camera) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: "Camera not found or permission denied." });
        const result = await require('../services/firmwareService').requestByOwner(camera.toObject ? camera.toObject() : camera, req.user.id);
        if (result.status === 200) {
            recordAudit(req, { action: 'firmware.update_requested', target: cameraTarget(camera), details: { to: result.body.update.toVersion, from: result.body.update.fromVersion } });
        }
        res.status(result.status).json(result.body);
    } catch (err) {
        sendServerError(res, err, { context: 'Firmware update' });
    }
}

/** PUT /api/cameras/:serial/firmware/auto { enabled, hour? } */
async function setFirmwareAuto(req, res) {
    try {
        const camera = await findManageableCamera(req.user, String(req.params.serial || ''));
        if (!camera) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: "Camera not found or permission denied." });
        const result = await require('../services/firmwareService').setAuto(camera.toObject ? camera.toObject() : camera, req.body || {}, req.user.id);
        if (result.status === 200) recordAudit(req, { action: 'firmware.auto_changed', target: cameraTarget(camera), details: { enabled: result.body.autoUpdate, hour: result.body.autoHour } });
        res.status(result.status).json(result.body);
    } catch (err) {
        sendServerError(res, err, { context: 'Firmware auto update' });
    }
}

/**
 * Take a snapshot right now (capture, store, AI analysis, alerts) and return the result
 */
async function captureNow(req, res) {
    const userId = req.user.id;
    const { deviceSerial } = req.body;
    if (!deviceSerial) return res.status(400).json({ success: false, message: "Missing deviceSerial." });
    try {
        const camera = await findManageableCamera(req.user, deviceSerial);
        if (!camera) {
            return res.status(404).json({ success: false, message: "Camera not found or permission denied." });
        }
        if (camera.simulated) return res.status(409).json({ success: false, code: 'SIMULATED_CAMERA', message: 'A simulated camera takes no photos on request.' });
        if (camera.adminDisabled?.at) return res.status(403).json(CAMERA_DISABLED);
        // Lazy require: captureJob pulls in the AI and S3 services
        const { captureAndSaveSnapshot } = require('../cron/captureJob');
        const saved = await captureAndSaveSnapshot(deviceSerial);
        if (!saved) {
            return res.status(502).json({ success: false, code: 'CAPTURE_FAILED', message: "The camera did not return an image. It may be offline." });
        }
        const snapshot = await Snapshot.findById(saved._id);
        res.json({
            success: true,
            snapshot,
            count: snapshot?.aiProcessed ? countPests(snapshot.aiResults?.summary) : null
        });
    } catch (err) {
        sendServerError(res, err, { context: 'Capture now' });
    }
}

/**
 * Device health for the user's cameras: last capture, snapshots and AI success over the last 24h
 */
async function getCamerasHealth(req, res) {
    try {
        const userId = req.user.id;
        const cameras = await viewableCameras(req.user);
        const serials = [...new Set(cameras.map(c => c.deviceSerial))];
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const [recent, latest] = await Promise.all([
            Snapshot.aggregate([
                { $match: { deviceSerial: { $in: serials }, createdAt: { $gte: since } } },
                { $group: { _id: '$deviceSerial', total: { $sum: 1 }, analyzed: { $sum: { $cond: ['$aiProcessed', 1, 0] } } } }
            ]),
            latestSnapshotTimeByCamera(serials)
        ]);
        const recentBy = new Map(recent.map(r => [r._id, r]));
        const latestBy = latest;

        res.json({
            success: true,
            health: cameras.map(cam => {
                const r = recentBy.get(cam.deviceSerial) || { total: 0, analyzed: 0 };
                return {
                    deviceSerial: cam.deviceSerial,
                    status: cam.status,
                    lastSync: cam.lastSync,
                    lastCaptureAt: cam.lastCaptureAt,
                    lastSnapshotAt: latestBy.get(cam.deviceSerial) || null,
                    snapshots24h: r.total,
                    analyzed24h: r.analyzed,
                    // null when nothing was captured, so the UI shows "--" instead of a misleading 0%
                    aiSuccessRate: r.total > 0 ? Math.round((r.analyzed / r.total) * 100) : null,
                    captureIntervalMinutes: cam.captureIntervalMinutes,
                    captureDaytimeOnly: cam.captureDaytimeOnly,
                    // Problems in the latest photo (services/imageQuality.js)
                    imageIssues: cam.imageQuality?.issues || [],
                    imageCheckedAt: cam.imageQuality?.checkedAt || null
                };
            })
        });
    } catch (err) {
        sendServerError(res, err, { context: 'Camera health' });
    }
}

/**
 * GET /api/user/cameras/threshold-suggestions
 * A suggested alert threshold for each camera the user can change, from its last 30 days.
 */
async function getThresholdSuggestions(req, res) {
    try {
        const cameras = await viewableCameras(req.user).select('deviceSerial deviceName alertThreshold trapKind userId sharedWith').lean();
        const manageable = [...new Map(cameras.filter(c => canManageCamera(req.user, c)).map(c => [c.deviceSerial, c])).values()];
        res.json({ success: true, days: thresholdService.DAYS, suggestions: await thresholdService.suggestThresholds(manageable) });
    } catch (err) {
        sendServerError(res, err, { context: 'Threshold suggestions' });
    }
}

module.exports = {
    getThresholdSuggestions,
    getCameraLog,
    downloadCameraLog,
    getCameraCrashes,
    startCameraLog,
    stopCameraLog,
    watchCameraLog,
    getFirmware,
    checkFirmware,
    updateFirmware,
    setFirmwareAuto,
    captureNow,
    getCamerasHealth,
    getUserCameras,
    addCamera,
    deleteCamera,
    updateCamera,
    updateCameraLocation,
    updateCameraCode,
    getLiveStream,
    getRecords,
    getPlaybackStream,
    disableStream,
    provisionCamera,
    getLive,
    requestLive,
    claimCamera,
    getDeviceSettings,
    updateDeviceSettings,
    deviceAction,
    deviceActionRequest,
    getPlayback,
    getCameraStatus,
    deviceView
};

