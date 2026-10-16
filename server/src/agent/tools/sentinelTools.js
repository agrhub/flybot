const mongoose = require('mongoose');
const { Snapshot } = require('../../models');
const { viewableCameras, findManageableCamera } = require('../../utils/ownership');
const { trapKindOf } = require('../../constants/trap');
const { photoQuota } = require('./actionTools');

/**
 * The assistant's two doors to the vision agent (flybot-aws): a deep look at one photo through
 * the Lambda's `deep` mode, and a proposed camera action shown as a confirm card.
 */

// ---------- Deep analysis of one photo ----------

const analyzePhotoDeepDeclaration = {
    name: 'analyze_photo_deep',
    description: 'Ask the vision agent (OpenCV 5 on AWS Lambda) a question about one trap photo: why the count changed, whether the card or lure needs attention, what the quality flags mean, what to do next. Give the photo id (from get_recent_snapshots or the Selected Photo in the UI context) or the camera serial for its latest photo. Returns the agent\'s answer (markdown) and its counts.',
    parameters: {
        type: 'OBJECT',
        properties: {
            snapshotId: { type: 'STRING', description: 'Photo id (preferred when the user talks about a photo)' },
            deviceSerial: { type: 'STRING', description: 'Camera serial: its latest photo is analyzed' },
            question: { type: 'STRING', description: 'The question, in the user\'s words' }
        },
        required: ['question']
    }
};

async function executeAnalyzePhotoDeep({ snapshotId, deviceSerial, question, userId, user, addCard = () => {} }) {
    if (!userId) return { error: 'Not authenticated.' };
    const visionLambda = require('../../services/visionLambda');
    if (!visionLambda.isConfigured()) return { error: 'The vision agent is not set up on this server (VISION_LAMBDA_NAME or VISION_LAMBDA_URL).' };
    const visible = await viewableCameras(user).select('deviceSerial deviceName trapKind platform latitude longitude selfRegistered unclaimed userId orgId').lean();
    let snap = null;
    if (snapshotId) {
        if (!mongoose.isValidObjectId(snapshotId)) return { error: 'Photo not found.' };
        snap = await Snapshot.findById(snapshotId).lean();
    } else if (deviceSerial) {
        if (!visible.some(c => c.deviceSerial === String(deviceSerial))) return { error: `Camera ${deviceSerial} not found.` };
        snap = await Snapshot.findOne({ deviceSerial: String(deviceSerial) }).sort({ createdAt: -1 }).lean();
        if (!snap) return { error: `Camera ${deviceSerial} has no photo yet.` };
    } else {
        return { error: 'Give the photo id or the camera serial.' };
    }
    if (!snap) return { error: 'Photo not found.' };
    const camera = visible.find(c => c.deviceSerial === snap.deviceSerial);
    if (!camera) return { error: 'Photo not found.' };
    // Plan limit (services/entitlements.js): LLM deep analyses per workspace per month
    const entitlements = require('../../services/entitlements');
    const blocked = await entitlements.checkDeepAnalysis(user, camera);
    if (blocked) return { error: blocked.body.message, code: 'UPGRADE_REQUIRED', limit: 'deepAnalysis', used: blocked.body.used, max: blocked.body.max };
    if (!photoQuota.take(String(userId))) return { error: 'Photos were looked at many times in the last hour. Please try again later.' };

    let response;
    try {
        response = await visionLambda.deepAnalyze(snap, camera, { question: String(question || '').slice(0, 1000), locale: user?.language === 'en' ? 'en' : 'vi' });
    } catch (err) {
        console.error('[Agent Tool] analyze_photo_deep failed:', err.code || '', err.message);
        return { error: err.code === 'timeout' ? 'The vision agent did not answer in time.' : 'The vision agent could not analyze this photo just now.' };
    }
    await entitlements.recordDeepAnalysis(camera);
    const counts = response.counts || {};
    addCard({
        type: 'photos',
        items: [{ id: String(snap._id), deviceSerial: snap.deviceSerial, name: camera.deviceName || snap.deviceSerial, at: snap.createdAt, count: Number.isFinite(counts.total) ? counts.total : (snap.aiProcessed ? snap.pestCount ?? null : null), imageKey: snap.s3Key }]
    });
    return {
        trap: camera.deviceName || snap.deviceSerial,
        trapKind: trapKindOf(camera),
        takenAt: snap.createdAt,
        answer: response.answer || '',
        counts: { total: Number.isFinite(counts.total) ? counts.total : null, byClass: counts.byClass || {} },
        quality: response.quality || null,
        diff: response.diff || null,
        proposals: Array.isArray(response.proposals) ? response.proposals.map(p => ({ action: p.action, params: p.params || {}, reason: p.reason || '' })) : [],
        traceId: response.traceId || null,
        storedCount: snap.aiProcessed ? snap.pestCount ?? null : null
    };
}

// ---------- A proposed camera action ----------

const proposeActionDeclaration = {
    name: 'propose_action',
    description: 'Propose a camera action the user confirms on a card: capture_now (an extra photo now), set_interval {minutes: 15|30|60|120} (capture every N minutes for 24 h), set_isp {brightness: -64..64, wdr: true|false} (CamOS cameras only), review_request (ask a person to check the latest photo), notify {message}. Use it for what the vision agent (analyze_photo_deep) proposes, or when the user asks for it. Nothing happens until the user presses Confirm.',
    parameters: {
        type: 'OBJECT',
        properties: {
            deviceSerial: { type: 'STRING', description: 'Camera serial' },
            action: { type: 'STRING', enum: ['capture_now', 'set_interval', 'set_isp', 'review_request', 'notify'] },
            minutes: { type: 'INTEGER', description: 'set_interval: 15, 30, 60 or 120' },
            brightness: { type: 'INTEGER', description: 'set_isp: -64..64' },
            wdr: { type: 'BOOLEAN', description: 'set_isp: wide dynamic range on/off' },
            message: { type: 'STRING', description: 'notify: the text' },
            snapshotId: { type: 'STRING', description: 'The photo the proposal is about, if any' },
            reason: { type: 'STRING', description: 'Why, in one sentence (shown on the card)' }
        },
        required: ['deviceSerial', 'action']
    }
};

async function executeProposeAction({ deviceSerial, action, minutes, brightness, wdr, message, snapshotId, reason, userId, user, addCard = () => {} }) {
    if (!userId) return { error: 'Not authenticated.' };
    const camera = await findManageableCamera(user, String(deviceSerial || ''));
    if (!camera) return { error: `Camera ${deviceSerial} not found, or the user cannot manage it.` };
    const sentinelService = require('../../services/sentinelService');
    const checked = sentinelService.checkAction(action, { minutes, brightness, wdr, message }, { camera });
    if (checked.error) return { error: checked.error };
    let snapshot = null;
    if (snapshotId) {
        if (!mongoose.isValidObjectId(snapshotId)) return { error: 'Photo not found.' };
        snapshot = await Snapshot.findOne({ _id: snapshotId, deviceSerial: camera.deviceSerial }).select('_id').lean();
        if (!snapshot) return { error: 'Photo not found.' };
    }
    addCard(sentinelService.actionCard({ ...checked, camera, reason: String(reason || '').slice(0, 300), snapshot }));
    return { proposed: true, action: checked.action, params: checked.params, message: 'Shown to the user with a Confirm button; nothing done yet.' };
}

const safe = (fn) => async (args) => {
    try {
        return await fn(args);
    } catch (err) {
        console.error('[Agent Tool] crashed:', err.message);
        return { error: 'This could not be looked up just now.' };
    }
};

module.exports = {
    sentinelDeclarations: [analyzePhotoDeepDeclaration, proposeActionDeclaration],
    sentinelExecutors: {
        analyze_photo_deep: safe(executeAnalyzePhotoDeep),
        propose_action: safe(executeProposeAction)
    }
};
