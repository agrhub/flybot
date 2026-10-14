const { viewableCameras, findManageableCamera } = require('../../utils/ownership');
const { Farm, Plot } = require('../../models');

// How long a chat reply waits for a capture and its AI analysis
const CAPTURE_WAIT_MS = 25000;

const getCamerasStatusDeclaration = {
    name: 'get_cameras_status',
    description: 'Get list of all surveillance cameras, serial numbers, the farm and plot each trap is in, online/offline connection status, video encryption, and alarm defence mode.',
    parameters: {
        type: 'OBJECT',
        properties: {}
    }
};

async function executeGetCamerasStatus({ userId, user }) {
    try {
        if (!userId) return { error: 'Not authenticated.' };
        const cameras = await viewableCameras(user).limit(50);
        // Farm and plot names, so "lô xoài A" can be matched to its traps
        const [farms, plots] = await Promise.all([
            Farm.find({ _id: { $in: cameras.map(c => c.farmId).filter(Boolean) } }).select('name').lean(),
            Plot.find({ _id: { $in: cameras.map(c => c.plotId).filter(Boolean) } }).select('name').lean()
        ]);
        const nameOf = (list, id) => (id ? list.find(x => String(x._id) === String(id))?.name || null : null);
        return {
            total: cameras.length,
            onlineCount: cameras.filter(c => c.status === 1).length,
            offlineCount: cameras.filter(c => c.status !== 1).length,
            cameras: cameras.map(c => ({
                deviceSerial: c.deviceSerial,
                deviceName: c.deviceName,
                farm: nameOf(farms, c.farmId),
                plot: nameOf(plots, c.plotId),
                status: c.status === 1 ? 'Online' : 'Offline',
                isEncrypt: c.isEncrypt === 1 ? 'Encrypted' : 'Unencrypted',
                hasValidateCode: !!c.validateCode,
                defence: c.defence === 1 ? 'Enabled' : 'Disabled',
                model: c.model || c.deviceType || 'EZVIZ'
            }))
        };
    } catch (err) {
        console.error('[Agent Tool] crashed:', err.message);
        return { error: 'This could not be looked up just now.' };
    }
}

const triggerCaptureSnapshotDeclaration = {
    name: 'trigger_capture_snapshot',
    description: 'Trigger immediate snapshot capture from a specific EZVIZ camera via device API.',
    parameters: {
        type: 'OBJECT',
        properties: {
            deviceSerial: {
                type: 'STRING',
                description: 'Camera Serial Number (e.g. AC6527557, BE4111159)'
            }
        },
        required: ['deviceSerial']
    }
};

async function executeTriggerCaptureSnapshot({ deviceSerial, userId, user, addAction, addCard = () => {} }) {
    try {
        if (!deviceSerial) return { error: 'Missing deviceSerial' };
        
        // Verify camera ownership
        // Capturing changes data: owners (manager) and admins only
        const cam = userId ? await findManageableCamera(user, String(deviceSerial)) : null;
        if (!cam) {
            return { error: `You do not have permission to control camera ${deviceSerial} or device not found.` };
        }

        // Same quota as the "Capture now" button, so the assistant cannot be used to bypass it
        const { captureQuota } = require('../../middlewares/rateLimit');
        if (!captureQuota.take(`${userId}:${deviceSerial}`)) {
            return { error: `Camera ${deviceSerial} was captured several times in the last minute. Please wait a moment and try again.` };
        }

        // Same pipeline as the "Capture now" button: capture, store, AI analysis, alerts.
        // The chat waits a while for it, not for as long as a slow AI analysis can take
        const { captureAndSaveSnapshot } = require('../../cron/captureJob');
        const run = captureAndSaveSnapshot(String(deviceSerial));
        const STILL_RUNNING = Symbol('running');
        let timer;
        const saved = await Promise.race([
            run,
            new Promise((resolve) => { timer = setTimeout(() => resolve(STILL_RUNNING), CAPTURE_WAIT_MS); })
        ]).finally(() => clearTimeout(timer));
        if (saved === STILL_RUNNING) {
            run.catch(() => {});
            addAction('CAPTURE_TRIGGERED', { deviceSerial, pending: true });
            return {
                success: true,
                pending: true,
                deviceSerial,
                message: `Capture of ${deviceSerial} started; the photo and its AI result will appear in the camera's history in a few minutes.`
            };
        }
        if (!saved) {
            return { error: `Camera ${deviceSerial} did not return an image. It may be offline.` };
        }
        const { Snapshot } = require('../../models');
        const { countPests } = require('../../services/notificationService');
        const snapshot = await Snapshot.findById(saved._id);
        addAction('CAPTURE_TRIGGERED', { deviceSerial, snapshotId: saved._id });
        addCard({
            type: 'photos',
            items: [{
                id: String(saved._id),
                deviceSerial: String(deviceSerial),
                name: cam.deviceName || String(deviceSerial),
                at: snapshot?.createdAt || saved.createdAt,
                count: snapshot?.aiProcessed ? countPests(snapshot.aiResults?.summary) : null,
                imageKey: saved.s3Key
            }]
        });
        return {
            success: true,
            deviceSerial,
            analyzed: !!snapshot?.aiProcessed,
            insectCount: snapshot?.aiProcessed ? countPests(snapshot.aiResults?.summary) : null,
            message: snapshot?.aiProcessed
                ? `New snapshot from ${deviceSerial} stored and analyzed.`
                : `New snapshot from ${deviceSerial} stored; AI analysis did not complete.`
        };
    } catch (err) {
        console.error('[Agent Tool] capture crashed:', err.message);
        return { error: `Could not capture an image from ${deviceSerial}.` };
    }
}

module.exports = {
    cameraDeclarations: [
        getCamerasStatusDeclaration,
        triggerCaptureSnapshotDeclaration
    ],
    cameraExecutors: {
        get_cameras_status: executeGetCamerasStatus,
        trigger_capture_snapshot: executeTriggerCaptureSnapshot
    }
};
