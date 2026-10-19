const fleetService = require('../services/fleetService');
const registryService = require('../services/registryService');
const firmwareService = require('../services/firmwareService');
const { recordAudit } = require('../services/auditService');
const { sendServerError } = require('../utils/http');
const { parseMultipart } = require('../utils/multipart');

/**
 * Admin: the camera fleet, the serial registry and the firmware releases (routes/adminRoutes.js).
 * Every change and every revealed verify code is audited.
 */
const send = (res, { status, body }) => res.status(status).json(body);
const serialOf = (req) => String(req.params.serial || '').slice(0, 64);
const handle = (context, fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (err) {
        sendServerError(res, err, { context });
    }
};

// ---------- Fleet ----------

const listFleet = handle('Admin fleet', async (req, res) => {
    res.json(await fleetService.list(req.query));
});

const revealCameraCode = handle('Admin reveal code', async (req, res) => {
    const result = await fleetService.revealCode(serialOf(req));
    if (result.status === 200) {
        recordAudit(req, { action: 'camera.verify_code_revealed', target: { type: 'camera', id: result.body.deviceSerial, label: result.body.deviceName } });
    }
    res.setHeader('Cache-Control', 'no-store');
    send(res, result);
});

const setCameraDisabled = handle('Admin pause camera', async (req, res) => {
    const serial = serialOf(req);
    const result = await fleetService.setDisabled(serial, req.body || {}, req.user.id);
    if (result.status === 200 && result.body.changed) {
        recordAudit(req, {
            action: result.body.disabled ? 'camera.disabled' : 'camera.enabled',
            target: { type: 'camera', id: serial, label: serial },
            details: { reason: String(req.body?.reason || '').slice(0, 200) }
        });
    }
    send(res, result);
});

// ---------- Registry ----------

const listRegistry = handle('Admin registry', async (req, res) => {
    res.json(await registryService.list(req.query));
});

const addRegistry = handle('Admin registry add', async (req, res) => {
    const result = await registryService.add(req.body, req.user.id);
    if (result.status === 201) recordAudit(req, { action: 'registry.added', target: { type: 'registry', id: result.body.serial, label: result.body.serial } });
    send(res, result);
});

const updateRegistry = handle('Admin registry update', async (req, res) => {
    const result = await registryService.update(serialOf(req), req.body);
    if (result.status === 200 && result.body.changed.length) {
        recordAudit(req, { action: 'registry.updated', target: { type: 'registry', id: result.body.serial, label: result.body.serial }, details: { changed: result.body.changed.join(',') } });
    }
    send(res, result);
});

const deleteRegistry = handle('Admin registry delete', async (req, res) => {
    const serial = serialOf(req).toUpperCase();
    const result = await registryService.remove(serial);
    if (result.status === 200) recordAudit(req, { action: 'registry.deleted', target: { type: 'registry', id: serial, label: serial } });
    send(res, result);
});

const revealRegistryCode = handle('Admin registry reveal', async (req, res) => {
    const result = await registryService.revealCode(serialOf(req));
    if (result.status === 200) recordAudit(req, { action: 'registry.verify_code_revealed', target: { type: 'registry', id: result.body.serial, label: result.body.serial } });
    res.setHeader('Cache-Control', 'no-store');
    send(res, result);
});

const importRegistry = handle('Admin registry import', async (req, res) => {
    const b = req.body || {};
    const result = await registryService.importCsv({ csv: b.csv, dryRun: b.dryRun === true, overwrite: b.overwrite === true, batch: typeof b.batch === 'string' ? b.batch : '' }, req.user.id);
    if (result.status === 200 && !result.body.dryRun && (result.body.created || result.body.updated)) {
        recordAudit(req, { action: 'registry.imported', target: { type: 'registry', id: 'import', label: String(b.batch || '').slice(0, 64) }, details: { created: result.body.created, updated: result.body.updated, errors: result.body.errorCount } });
    }
    send(res, result);
});

const backfillRegistry = handle('Admin registry backfill', async (req, res) => {
    const result = await registryService.backfill(req.user.id);
    if (result.body.added) recordAudit(req, { action: 'registry.imported', target: { type: 'registry', id: 'backfill', label: 'backfill' }, details: { created: result.body.added } });
    send(res, result);
});

// ---------- Firmware ----------

const listFirmware = handle('Admin firmware', async (req, res) => {
    res.json(await firmwareService.listReleases());
});

/**
 * POST /api/admin/firmware: multipart (part `file` + fields model, version, sha256?, notesEn?, notesVi?,
 * minBatteryPct?), or JSON { url, model, version, sha256? } or { githubTag, repo? }.
 */
const addFirmware = handle('Admin firmware add', async (req, res) => {
    let result;
    if (Buffer.isBuffer(req.body)) {
        let parts;
        try {
            parts = parseMultipart(req.body, req.get('Content-Type'));
        } catch (err) {
            return res.status(400).json({ success: false, message: 'The upload is not valid multipart data.' });
        }
        const field = (name) => parts.find(p => p.name === name)?.data?.toString('utf8').trim();
        const file = parts.find(p => p.name === 'file');
        if (!file?.data?.length) return res.status(400).json({ success: false, message: 'A firmware file is required.' });
        const pct = field('minBatteryPct');
        result = await firmwareService.addRelease({
            buffer: file.data,
            fileName: file.filename,
            model: field('model'),
            version: field('version'),
            expectedSha256: field('sha256') || undefined,
            notes: { en: field('notesEn') || '', vi: field('notesVi') || '' },
            minBatteryPct: pct ? Number(pct) : undefined,
            source: { kind: 'upload' }
        }, req.user.id);
    } else if (req.body?.githubTag) {
        result = await firmwareService.importGithubRelease(req.body, req.user.id);
    } else if (req.body?.url) {
        result = await firmwareService.addFromUrl(req.body, req.user.id);
    } else {
        return res.status(400).json({ success: false, message: 'Upload a file, or give url or githubTag.' });
    }
    if (result.status === 201) {
        const added = result.body.release ? [result.body.release] : (result.body.results || []).filter(r => r.status === 'added');
        for (const r of added) recordAudit(req, { action: 'firmware.added', target: { type: 'firmware', id: r.id, label: `${r.model} ${r.version}` } });
    }
    send(res, result);
});

const updateFirmware = handle('Admin firmware update', async (req, res) => {
    const result = await firmwareService.updateRelease(req.params.id, req.body);
    if (result.status === 200) {
        const r = result.body.release;
        recordAudit(req, { action: 'firmware.updated', target: { type: 'firmware', id: r.id, label: `${r.model} ${r.version}` }, details: { current: r.current, ...(result.body.announced || {}) } });
    }
    send(res, result);
});

const deleteFirmware = handle('Admin firmware delete', async (req, res) => {
    const result = await firmwareService.deleteRelease(req.params.id);
    if (result.status === 200) recordAudit(req, { action: 'firmware.deleted', target: { type: 'firmware', id: String(req.params.id), label: String(req.params.id) } });
    send(res, result);
});

const rolloutFirmware = handle('Admin firmware rollout', async (req, res) => {
    const result = await firmwareService.rollout(req.params.id, req.body, req.user.id);
    if (result.status === 200 && result.body.created) {
        recordAudit(req, { action: 'firmware.rollout', target: { type: 'firmware', id: String(req.params.id), label: result.body.batchId }, details: { cameras: result.body.created, skipped: result.body.skipped.length } });
    }
    send(res, result);
});

const listFirmwareUpdates = handle('Admin firmware updates', async (req, res) => {
    res.json(await firmwareService.listUpdates(req.query));
});

const cancelFirmwareUpdate = handle('Admin firmware cancel', async (req, res) => {
    const result = await firmwareService.cancelUpdate(req.params.id);
    if (result.status === 200) recordAudit(req, { action: 'firmware.update_cancelled', target: { type: 'camera', id: result.body.update.deviceSerial, label: result.body.update.toVersion } });
    send(res, result);
});

const retryFirmwareUpdate = handle('Admin firmware retry', async (req, res) => {
    const result = await firmwareService.retryUpdate(req.params.id, req.user.id);
    if (result.status === 200) recordAudit(req, { action: 'firmware.update_requested', target: { type: 'camera', id: result.body.update.deviceSerial, label: result.body.update.toVersion }, details: { retry: true } });
    send(res, result);
});

module.exports = {
    listFleet,
    revealCameraCode,
    setCameraDisabled,
    listRegistry,
    addRegistry,
    updateRegistry,
    deleteRegistry,
    revealRegistryCode,
    importRegistry,
    backfillRegistry,
    listFirmware,
    addFirmware,
    updateFirmware,
    deleteFirmware,
    rolloutFirmware,
    listFirmwareUpdates,
    cancelFirmwareUpdate,
    retryFirmwareUpdate
};
