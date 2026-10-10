const { Camera } = require('../../models');
const ezvizService = require('../../services/ezvizService');

const getCamerasStatusDeclaration = {
    name: 'get_cameras_status',
    description: 'Get list of all surveillance cameras, serial numbers, online/offline connection status, video encryption, and alarm defence mode.',
    parameters: {
        type: 'OBJECT',
        properties: {}
    }
};

async function executeGetCamerasStatus({ userId }) {
    try {
        if (!userId) return { error: 'Not authenticated.' };
        const cameras = await Camera.find({ userId }).limit(50);
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

async function executeTriggerCaptureSnapshot({ deviceSerial, userId, addAction }) {
    try {
        if (!deviceSerial) return { error: 'Missing deviceSerial' };
        
        // Verify camera ownership
        const cam = userId ? await Camera.findOne({ userId, deviceSerial: String(deviceSerial) }) : null;
        if (!cam) {
            return { error: `You do not have permission to control camera ${deviceSerial} or device not found.` };
        }

        const result = await ezvizService.captureDevice(deviceSerial);
        addAction('CAPTURE_TRIGGERED', { deviceSerial, result });
        return {
            success: true,
            deviceSerial,
            message: `Snapshot request sent to camera ${deviceSerial}. New image will be uploaded and analyzed by AI.`
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

async function executeUpdateCameraValidateCode({ deviceSerial, validateCode, userId, addAction }) {
    try {
        if (!deviceSerial || !validateCode) return { error: 'Missing deviceSerial or validateCode' };

        // Verify camera ownership
        const camera = userId ? await Camera.findOne({ userId, deviceSerial: String(deviceSerial) }) : null;
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
