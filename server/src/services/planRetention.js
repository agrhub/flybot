const env = require('../config/env');

/**
 * Photos kept per plan (Plan.retentionDays, services/entitlements.js): the hourly job deletes a
 * workspace's photos older than its plan allows. Off unless PLAN_RETENTION=true (the admin's
 * global retention in Settings applies either way); a batch per run so the server keeps answering.
 */
const MAX_PER_RUN = 2000;

async function cleanupByPlanRetention({ now = new Date(), maxPerRun = MAX_PER_RUN } = {}) {
    if (!env.PLAN_RETENTION) return { enabled: false, photos: 0 };
    const { Organization, Camera, Snapshot } = require('../models');
    const entitlements = require('./entitlements');
    const { deleteS3Object } = require('./s3Service');
    let photos = 0;
    const workspaces = await Organization.find({}).select('_id plan members billing').lean();
    for (const ws of workspaces) {
        if (photos >= maxPerRun) break;
        const owner = (ws.members || []).find(m => m.role === 'owner' && m.userId);
        const { User } = require('../models');
        const ownerDoc = owner ? await User.findById(owner.userId).select('role email').lean() : null;
        const ent = await entitlements.getEntitlements(ownerDoc, ws, now);
        if (ent.retentionDays === null) continue;
        const serials = await Camera.distinct('deviceSerial', { orgId: ws._id });
        if (!serials.length) continue;
        const cutoff = new Date(now.getTime() - ent.retentionDays * 24 * 3600 * 1000);
        const old = await Snapshot.find({ deviceSerial: { $in: serials }, createdAt: { $lt: cutoff } }).select('s3Key').limit(maxPerRun - photos).lean();
        for (const p of old) {
            if (p.s3Key) await deleteS3Object(p.s3Key).catch(err => console.warn(`⚠️ Photo ${p.s3Key} not deleted: ${err.message}`));
        }
        if (old.length) await Snapshot.deleteMany({ _id: { $in: old.map(p => p._id) } });
        photos += old.length;
    }
    if (photos) console.log(`🧹 Plan retention: ${photos} photo(s) removed.`);
    return { enabled: true, photos };
}

module.exports = { cleanupByPlanRetention };
