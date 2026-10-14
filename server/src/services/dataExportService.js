const { once } = require('events');
const { Zip, ZipDeflate, strToU8 } = require('fflate');
const { Camera, Farm, Plot, DailyStat, Snapshot, Treatment, MaintenanceEvent, Dashboard, ChatSession } = require('../models');

/**
 * "Download all my data": a ZIP of everything a person owns, as CSV (tables) and JSON
 * (settings, reports), streamed so a long photo history never sits in memory at once.
 * Photos themselves are not included (they stay in storage); their analysis is.
 */
const CHUNK = 64 * 1024;

// A spreadsheet runs a cell starting with = + - @ as a formula: names come from users
function csvCell(value) {
    if (value === null || value === undefined) return '';
    let text = value instanceof Date ? value.toISOString() : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
const csvRow = (cells) => cells.map(csvCell).join(',');

const summaryText = (summary) => {
    if (!summary) return '';
    const entries = summary instanceof Map ? [...summary.entries()] : Object.entries(summary);
    return entries.map(([name, count]) => `${name}:${count}`).join(' ');
};

const README = (user, generatedAt) => `FlyBot data export for ${user.email}
Made on ${generatedAt.toISOString()}

account.json        your profile and notification settings (no password)
cameras.csv         the cameras you own
farms.json          your farms and their plots
daily_stats.csv     one row per camera and day: highest count, total, photos, species
detections.csv      every analyzed photo: time, camera, insects by species, review
treatments.csv      treatments you logged, or logged on your cameras
maintenance.csv     card changes and other work on your cameras
reports.json        your reports (layout and settings)
assistant.json      your conversations with the FlyBot assistant

Times are UTC (ISO 8601). Photos are not included.
`;

/**
 * Write the ZIP to `out` (a writable stream such as the HTTP response).
 * Resolves when the archive is complete.
 */
function writeExport(user, out, now = new Date()) {
    return new Promise((resolve, reject) => {
        const zip = new Zip((err, chunk, final) => {
            if (err) return reject(err);
            out.write(Buffer.from(chunk));
            if (final) resolve();
        });
        const addText = (name, text) => {
            const file = new ZipDeflate(name, { level: 6 });
            zip.add(file);
            file.push(strToU8(text), true);
        };
        // A table from a database cursor, a few rows at a time
        const addCsv = async (name, header, cursor, toRow) => {
            const file = new ZipDeflate(name, { level: 6 });
            zip.add(file);
            let buffer = csvRow(header) + '\n';
            for await (const doc of cursor) {
                buffer += csvRow(toRow(doc)) + '\n';
                if (buffer.length > CHUNK) {
                    file.push(strToU8(buffer));
                    buffer = '';
                    // A slow connection: wait for it to take what was sent before reading more
                    // (or for it to close, when the person gave up)
                    if (out.writableNeedDrain) await Promise.race([once(out, 'drain'), once(out, 'close')]);
                    if (out.destroyed) throw new Error('The download was closed.');
                }
            }
            file.push(strToU8(buffer), true);
        };

        (async () => {
            const cameras = await Camera.find({ userId: user._id }).lean();
            const serials = cameras.map(c => c.deviceSerial);
            const farms = await Farm.find({ ownerId: user._id }).lean();
            const plots = await Plot.find({ farmId: { $in: farms.map(f => f._id) } }).lean();
            const plotName = new Map(plots.map(p => [String(p._id), p.name]));
            const farmName = new Map(farms.map(f => [String(f._id), f.name]));

            addText('README.txt', README(user, now));
            addText('account.json', JSON.stringify({
                name: user.name, email: user.email, role: user.role, language: user.language,
                emailVerified: user.emailVerified, createdAt: user.createdAt, notificationPrefs: user.notificationPrefs
            }, null, 2));
            await addCsv('cameras.csv', ['deviceSerial', 'name', 'trapKind', 'alertThreshold', 'latitude', 'longitude', 'farm', 'plot', 'addedAt'],
                cameras, c => [c.deviceSerial, c.deviceName, c.trapKind || 'sticky', c.alertThreshold, c.latitude, c.longitude,
                    c.farmId ? farmName.get(String(c.farmId)) : '', c.plotId ? plotName.get(String(c.plotId)) : '', c.addedAt]);
            addText('farms.json', JSON.stringify(farms.map(f => ({
                name: f.name, description: f.description, createdAt: f.createdAt,
                sharedWith: (f.sharedWith || []).map(s => s.email),
                plots: plots.filter(p => String(p.farmId) === String(f._id)).map(p => ({ name: p.name, areaHa: p.areaHa, alertThreshold: p.alertThreshold, boundary: p.boundary }))
            })), null, 2));
            await addCsv('daily_stats.csv', ['day', 'deviceSerial', 'highestCount', 'total', 'photos', 'species'],
                DailyStat.find({ deviceSerial: { $in: serials } }).sort({ deviceSerial: 1, day: 1 }).lean().cursor(),
                r => [r.day, r.deviceSerial, r.peak, r.total, r.scans, (r.species || []).map(s => `${s.name}:${s.total}`).join(' ')]);
            await addCsv('detections.csv', ['time', 'deviceSerial', 'analyzed', 'pests', 'bySpecies', 'review', 'reviewedAt'],
                Snapshot.find({ deviceSerial: { $in: serials } }).sort({ createdAt: 1 })
                    .select('deviceSerial createdAt aiProcessed pestCount aiResults.summary review.status review.reviewedAt').lean().cursor(),
                s => [s.createdAt, s.deviceSerial, s.aiProcessed ? 'yes' : 'no', s.pestCount, summaryText(s.aiResults?.summary), s.review?.status, s.review?.reviewedAt]);
            await addCsv('treatments.csv', ['time', 'type', 'cameras', 'product', 'activeIngredient', 'dose', 'area', 'operator', 'preHarvestDays', 'note'],
                Treatment.find({ $or: [{ createdBy: user._id }, { cameraSerials: { $in: serials } }] }).sort({ at: 1 }).lean().cursor(),
                t => [t.at, t.type, t.cameraSerials.join(' '), t.product, t.activeIngredient, t.dose, t.area, t.operator, t.preHarvestDays, t.note]);
            await addCsv('maintenance.csv', ['time', 'deviceSerial', 'type', 'source', 'note', 'by'],
                MaintenanceEvent.find({ deviceSerial: { $in: serials } }).sort({ at: 1 }).lean().cursor(),
                e => [e.at, e.deviceSerial, e.type, e.source, e.note, e.userEmail]);
            const reports = await Dashboard.find({ ownerId: user._id }).lean();
            addText('reports.json', JSON.stringify(reports.map(({ _id, ownerId, publicToken, sharedWith, ...rest }) => ({ ...rest, sharedWith: (sharedWith || []).map(s => s.email) })), null, 2));
            const chats = await ChatSession.find({ userId: user._id }).lean();
            addText('assistant.json', JSON.stringify(chats.map(({ _id, userId, ...rest }) => rest), null, 2));
            zip.end();
        })().catch(reject);
    });
}

module.exports = {
    csvCell,
    writeExport
};
