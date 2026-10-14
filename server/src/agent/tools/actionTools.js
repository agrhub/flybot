const mongoose = require('mongoose');
const { Snapshot, Farm, Plot } = require('../../models');
const { viewableCameras, findManageableCamera, canManageCamera } = require('../../utils/ownership');
const { createQuota } = require('../../middlewares/rateLimit');
const { countPests } = require('../../services/notificationService');
const { TREATMENT_TYPES } = require('../../models/Treatment');
const { trapKindOf } = require('../../constants/trap');

// Each look at a photo is a vision model call: 20 per person per hour
const photoQuota = createQuota({ windowMs: 60 * 60 * 1000, max: 20 });
const DAY_MS = 24 * 60 * 60 * 1000;
const plain = (summary) => (summary instanceof Map ? Object.fromEntries(summary) : (summary || {}));

// ---------- Look at one photo ----------

const inspectPhotoDeclaration = {
    name: 'inspect_photo',
    description: 'Look at one trap photo and answer a question about it (what insects are on it, whether the count looks right, dirt, glare, blur, a full card). Use the photo id from get_recent_snapshots or from the selected photo in the UI context.',
    parameters: {
        type: 'OBJECT',
        properties: {
            snapshotId: { type: 'STRING', description: 'Photo id' },
            question: { type: 'STRING', description: 'What to look for, in the user\'s words' }
        },
        required: ['snapshotId']
    }
};

async function executeInspectPhoto({ snapshotId, question, userId, user, addCard = () => {} }) {
    if (!userId) return { error: 'Not authenticated.' };
    if (!mongoose.isValidObjectId(snapshotId)) return { error: 'Photo not found.' };
    const snap = await Snapshot.findById(snapshotId).select('deviceSerial s3Key createdAt aiProcessed aiResults.summary pestCount').lean();
    if (!snap) return { error: 'Photo not found.' };
    const visible = await viewableCameras(user).select('deviceSerial deviceName').lean();
    const camera = visible.find(c => c.deviceSerial === snap.deviceSerial);
    if (!camera) return { error: 'Photo not found.' };
    if (!photoQuota.take(String(userId))) return { error: 'Photos were looked at many times in the last hour. Please try again later.' };

    const summary = plain(snap.aiResults?.summary);
    const count = snap.pestCount ?? countPests(summary);
    const context = snap.aiProcessed ? `${count} pests; by label: ${JSON.stringify(summary)}` : 'not analyzed';
    const image = await require('../../services/s3Service').readS3Buffer(snap.s3Key);
    const answer = await require('../../services/aiService').describePhoto(image, String(question || 'What is on this trap photo? Does the count look right?').slice(0, 500), {
        context,
        language: user?.language
    });
    addCard({
        type: 'photos',
        items: [{ id: String(snap._id), deviceSerial: snap.deviceSerial, name: camera.deviceName || snap.deviceSerial, at: snap.createdAt, count: snap.aiProcessed ? count : null, imageKey: snap.s3Key }]
    });
    return { trap: camera.deviceName || snap.deviceSerial, takenAt: snap.createdAt, detectedPests: snap.aiProcessed ? count : null, observation: answer };
}

// ---------- Changes the user confirms ----------
// These tools never write: they return a proposal, shown as a card with Confirm / Cancel. The
// change is made only when the user confirms it (POST /api/ai/chat/confirm), from the stored card.

const proposeCardChangeDeclaration = {
    name: 'propose_card_change',
    description: 'Propose recording that the sticky card of a trap was replaced (counts start again). Nothing is recorded until the user presses Confirm on the card shown with your answer.',
    parameters: {
        type: 'OBJECT',
        properties: {
            deviceSerial: { type: 'STRING', description: 'Camera Serial Number of the trap' },
            at: { type: 'STRING', description: 'When it was replaced, ISO date-time (default: now)' },
            note: { type: 'STRING', description: 'Optional note' }
        },
        required: ['deviceSerial']
    }
};

async function executeProposeCardChange({ deviceSerial, at, note, userId, user, addCard = () => {} }) {
    if (!userId) return { error: 'Not authenticated.' };
    const camera = await findManageableCamera(user, String(deviceSerial || ''));
    if (!camera) return { error: `Camera ${deviceSerial} not found, or the user cannot manage it.` };
    if (trapKindOf(camera) === 'lure') return { error: 'This is a lure trap: it has no sticky card.' };
    const when = at ? new Date(at) : new Date();
    if (isNaN(when) || when > new Date(Date.now() + 5 * 60 * 1000) || when < new Date(Date.now() - 90 * DAY_MS)) {
        return { error: 'Invalid date (up to 90 days back, not in the future).' };
    }
    addCard({
        type: 'confirm',
        action: 'card_change',
        state: 'pending',
        payload: { deviceSerial: camera.deviceSerial, type: 'card_replaced', at: when.toISOString(), note: String(note || '').slice(0, 300) },
        summary: { trap: camera.deviceName || camera.deviceSerial, at: when.toISOString() }
    });
    return { proposed: true, message: 'Shown to the user with a Confirm button; not recorded yet.' };
}

const proposeTreatmentDeclaration = {
    name: 'propose_treatment',
    description: `Propose adding a treatment to the farm logbook (type: ${TREATMENT_TYPES.join(', ')}). A spray needs the product. Give the traps, or the plot or farm name the user said (e.g. "lô xoài A"): its traps are used. Nothing is recorded until the user presses Confirm on the card shown with your answer.`,
    parameters: {
        type: 'OBJECT',
        properties: {
            cameraSerials: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Traps in the treated area' },
            plot: { type: 'STRING', description: 'Name of the treated plot or farm, as the user said it, instead of cameraSerials' },
            type: { type: 'STRING', enum: TREATMENT_TYPES },
            at: { type: 'STRING', description: 'When, ISO date-time in the farm time zone (default: now). "Sáng nay" is today 07:00, "chiều qua" yesterday 16:00.' },
            product: { type: 'STRING' },
            activeIngredient: { type: 'STRING' },
            dose: { type: 'STRING' },
            area: { type: 'STRING' },
            operator: { type: 'STRING', description: 'Who did it' },
            preHarvestDays: { type: 'INTEGER', description: 'Pre-harvest interval in days (from the product label), if the user gave it' },
            note: { type: 'STRING' }
        },
        required: ['type']
    }
};

// "Lô xoài A" -> "lo xoai a": names compared without case or accents
const fold = (text) => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const sameName = (name, key) => fold(name) === key;
const looseName = (name, key) => fold(name).includes(key) || key.includes(fold(name));

/** The traps of a plot (or of a whole farm) the user can manage, found by its name. */
async function trapsOfPlace(user, name) {
    const key = fold(name);
    if (!key) return { error: 'Give the plot or farm name.' };
    const cameras = await viewableCameras(user).select('deviceSerial userId sharedWith farmId plotId');
    const mine = cameras.filter(c => canManageCamera(user, c));
    const plots = await Plot.find({ _id: { $in: mine.map(c => c.plotId).filter(Boolean) } }).select('name').lean();
    const plot = plots.find(p => sameName(p.name, key)) || plots.find(p => looseName(p.name, key));
    if (plot) return { serials: mine.filter(c => String(c.plotId) === String(plot._id)).map(c => c.deviceSerial), place: plot.name };
    const farms = await Farm.find({ _id: { $in: mine.map(c => c.farmId).filter(Boolean) } }).select('name').lean();
    const farm = farms.find(f => sameName(f.name, key)) || farms.find(f => looseName(f.name, key));
    if (farm) return { serials: mine.filter(c => String(c.farmId) === String(farm._id)).map(c => c.deviceSerial), place: farm.name };
    return { error: `No plot or farm named "${name}" with traps the user can manage. Their plots: ${plots.map(p => p.name).join(', ') || 'none'}.` };
}

async function executeProposeTreatment({ cameraSerials, plot, type, at, product, activeIngredient, dose, area, operator, preHarvestDays, note, userId, user, addCard = () => {} }) {
    if (!userId) return { error: 'Not authenticated.' };
    let serials = cameraSerials;
    let place = null;
    if ((!Array.isArray(serials) || !serials.length) && plot) {
        const found = await trapsOfPlace(user, plot);
        if (found.error) return { error: found.error };
        if (!found.serials.length) return { error: `${found.place} has no traps.` };
        serials = found.serials;
        place = found.place;
    }
    if (!Array.isArray(serials) || !serials.length) return { error: 'Give the traps or the plot that was treated.' };
    const body = { cameraSerials: serials, type, at: at || new Date().toISOString() };
    // The plot named is also the treated area, unless one was given
    for (const [key, value] of Object.entries({ product, activeIngredient, dose, area: area || place, operator, note })) {
        if (value !== undefined && value !== null && value !== '') body[key] = String(value);
    }
    if (Number.isInteger(preHarvestDays)) body.preHarvestDays = preHarvestDays;
    // The same checks as the logbook form
    const { validateInput } = require('../../controllers/treatmentController');
    const checked = await validateInput(body, user);
    if (checked.error) return { error: checked.error };
    const cams = await viewableCameras(user).select('deviceSerial deviceName').lean();
    const names = new Map(cams.map(c => [c.deviceSerial, c.deviceName || c.deviceSerial]));
    addCard({
        type: 'confirm',
        action: 'treatment',
        state: 'pending',
        payload: { ...body, at: checked.value.at.toISOString() },
        summary: {
            type: checked.value.type,
            at: checked.value.at.toISOString(),
            product: checked.value.product || null,
            area: checked.value.area || null,
            preHarvestDays: checked.value.preHarvestDays ?? null,
            traps: checked.value.cameraSerials.map(s => names.get(s) || s)
        }
    });
    return { proposed: true, message: 'Shown to the user with a Confirm button; not recorded yet.' };
}

const safe = (fn) => async (args) => {
    try {
        return await fn(args);
    } catch (err) {
        // Internal details stay in the log
        console.error('[Agent Tool] crashed:', err.message);
        return { error: 'This could not be looked up just now.' };
    }
};

module.exports = {
    photoQuota,
    actionDeclarations: [inspectPhotoDeclaration, proposeCardChangeDeclaration, proposeTreatmentDeclaration],
    actionExecutors: {
        inspect_photo: safe(executeInspectPhoto),
        propose_card_change: safe(executeProposeCardChange),
        propose_treatment: safe(executeProposeTreatment)
    }
};
