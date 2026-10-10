const { viewableCameras, findManageableCamera } = require('../../utils/ownership');

const getCamerasStatusDeclaration = {
    name: 'get_cameras_status',
    description: 'Get list of all surveillance cameras, serial numbers, online/offline connection status, video encryption, and alarm defence mode.',
    parameters: {
        type: 'OBJECT',
        properties: {}
    }
};

async function executeGetCamerasStatus({ userId, user }) {
    try {
        if (!userId) return { error: 'Not authenticated.' };
        const cameras = await viewableCameras(user).limit(50);
        return {
            total: cameras.length,
            onlineCount: cameras.filter(c => c.status === 1).length,
            offlineCount: cameras.filter(c => c.status !== 1).length,
            cameras: cameras.map(c => ({
                deviceSerial: c.deviceSerial,
                deviceName: c.deviceName,
                status: c.status === 1 ? 'Online' : 'Offline',
                isEncrypt: c.isEncrypt === 1 ? 'Encrypted' : 'Unencrypted',
                hasValidateCode: !!c.validateCode,
                defence: c.defence === 1 ? 'Enabled' : 'Disabled',
                model: c.model || c.deviceType || 'EZVIZ'
            }))
        };
    } catch (err) {
        return { error: err.message };
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

async function executeTriggerCaptureSnapshot({ deviceSerial, userId, user, addAction }) {
    try {
        if (!deviceSerial) return { error: 'Missing deviceSerial' };
        
        // Verify camera ownership
        // Capturing changes data: owners (manager) and admins only
        const cam = userId ? await findManageableCamera(user, String(deviceSerial)) : null;
        if (!cam) {
            return { error: `You do not have permission to control camera ${deviceSerial} or device not found.` };
        }

        // Same pipeline as the "Capture now" button: capture, store, AI analysis, alerts
        const { captureAndSaveSnapshot } = require('../../cron/captureJob');
        const saved = await captureAndSaveSnapshot(String(deviceSerial));
        if (!saved) {
            return { error: `Camera ${deviceSerial} did not return an image. It may be offline.` };
        }
        const { Snapshot } = require('../../models');
        const { countPests } = require('../../services/notificationService');
        const snapshot = await Snapshot.findById(saved._id);
        addAction('CAPTURE_TRIGGERED', { deviceSerial, snapshotId: saved._id });
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
        return { error: `Could not capture image from ${deviceSerial}: ${err.message}` };
    }
}

const updateCameraValidateCodeDeclaration = {
    name: 'update_camera_validate_code',
    description: 'Update or change camera verification code (video encryption password).',
    parameters: {
        type: 'OBJECT',
        properties: {
            deviceSerial: {
                type: 'STRING',
                description: 'Camera Serial Number'
            },
            validateCode: {
                type: 'STRING',
                description: 'New camera verification code'
            }
        },
        required: ['deviceSerial', 'validateCode']
    }
};

async function executeUpdateCameraValidateCode({ deviceSerial, validateCode, userId, user, addAction }) {
    try {
        if (!deviceSerial || !validateCode) return { error: 'Missing deviceSerial or validateCode' };

        // Verify camera ownership
        const camera = userId ? await findManageableCamera(user, String(deviceSerial)) : null;
        if (!camera) {
            return { error: `You do not have permission to modify camera ${deviceSerial} or device not found.` };
        }

        camera.validateCode = String(validateCode).trim();
        await camera.save();

        addAction('UPDATE_CODE', { deviceSerial, validateCode });
        return {
            success: true,
            deviceSerial,
            message: `Updated verification code for camera ${camera.deviceName} (${deviceSerial}).`
        };
    } catch (err) {
        return { error: err.message };
    }
}

module.exports = {
    cameraDeclarations: [
        getCamerasStatusDeclaration,
        triggerCaptureSnapshotDeclaration,
        updateCameraValidateCodeDeclaration
    ],
    cameraExecutors: {
        get_cameras_status: executeGetCamerasStatus,
        trigger_capture_snapshot: executeTriggerCaptureSnapshot,
        update_camera_validate_code: executeUpdateCameraValidateCode
    }
};
