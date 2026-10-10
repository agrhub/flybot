const { User, Camera } = require('../models');

/**
 * Give a role to accounts created before roles existed (idempotent; only touches
 * accounts without a stored role):
 *  - if there is no admin yet, the earliest account becomes admin
 *  - accounts that own cameras become manager, so they keep managing them
 *  - everyone else becomes user
 */
async function ensureRoles() {
    const users = User.collection;
    const missing = await users.countDocuments({ role: { $exists: false } });
    const adminCount = await users.countDocuments({ role: 'admin' });
    if (missing === 0 && adminCount > 0) return { changed: 0 };

    let changed = 0;
    if (adminCount === 0) {
        const first = await users.find({}).sort({ createdAt: 1, _id: 1 }).limit(1).next();
        if (first) {
            await users.updateOne({ _id: first._id }, { $set: { role: 'admin' } });
            console.log(`👑 ${first.email} is the first account and is now admin.`);
            changed++;
        }
    }

    const owners = (await Camera.distinct('userId')).filter(Boolean);
    const toManager = await users.updateMany(
        { role: { $exists: false }, _id: { $in: owners } },
        { $set: { role: 'manager' } }
    );
    const toUser = await users.updateMany({ role: { $exists: false } }, { $set: { role: 'user' } });
    changed += toManager.modifiedCount + toUser.modifiedCount;

    if (changed > 0) {
        console.log(`🔐 Roles assigned: ${toManager.modifiedCount} manager(s), ${toUser.modifiedCount} user(s).`);
    }
    return { changed };
}

/**
 * Before phase 3 the same device could be added by several accounts (one record each).
 * Now a serial is unique: keep the earliest record as the owner and turn the other
 * accounts into people the camera is shared with. Their per-account settings on the
 * duplicate records (name, threshold, location) are dropped in favor of the owner's.
 *
 * Changes data, so it is not run automatically: use scripts/merge_duplicate_cameras.js.
 * @returns {{ groups: number, merged: number, details: Array }}
 */
async function mergeDuplicateCameras({ apply = false } = {}) {
    const cameras = Camera.collection;
    const groups = await cameras.aggregate([
        { $group: { _id: '$deviceSerial', ids: { $push: '$_id' }, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } }
    ]).toArray();

    const details = [];
    let merged = 0;
    for (const group of groups) {
        const docs = await cameras.find({ _id: { $in: group.ids } }).sort({ addedAt: 1, _id: 1 }).toArray();
        const [keeper, ...duplicates] = docs;
        const shares = [...(keeper.sharedWith || [])];
        for (const dup of duplicates) {
            if (!dup.userId || String(dup.userId) === String(keeper.userId)) continue;
            if (shares.some(sh => String(sh.userId) === String(dup.userId))) continue;
            const user = await User.collection.findOne({ _id: dup.userId }, { projection: { email: 1 } });
            if (!user) continue;
            shares.push({ userId: dup.userId, email: String(user.email).toLowerCase(), sharedBy: keeper.userId, sharedAt: dup.addedAt || new Date() });
        }
        details.push({ deviceSerial: group._id, ownerId: String(keeper.userId), removed: duplicates.length, sharedWith: shares.length });
        if (apply) {
            await cameras.updateOne({ _id: keeper._id }, { $set: { sharedWith: shares } });
            await cameras.deleteMany({ _id: { $in: duplicates.map(d => d._id) } });
        }
        merged += duplicates.length;
    }
    return { groups: groups.length, merged, details };
}

/**
 * Store every email lowercase (new accounts already are). An address that differs only in
 * case from another account is left alone and reported, since merging accounts needs a person.
 * Idempotent. Returns { changed, conflicts }.
 */
async function lowercaseEmails() {
    const users = User.collection;
    const mixed = await users.find({ email: { $regex: '[A-Z]' } }, { projection: { email: 1 } }).toArray();
    let changed = 0;
    const conflicts = [];
    for (const user of mixed) {
        const lower = user.email.toLowerCase();
        const clash = await users.findOne({ email: lower, _id: { $ne: user._id } }, { projection: { _id: 1 } });
        if (clash) {
            conflicts.push(user.email);
            continue;
        }
        await users.updateOne({ _id: user._id }, { $set: { email: lower } });
        changed++;
    }
    if (changed) console.log(`✉️ Lowercased ${changed} account email(s).`);
    if (conflicts.length) {
        console.warn(`⚠️ ${conflicts.length} account(s) share an email with another account except for letter case: ${conflicts.join(', ')}. Merge or delete one of each pair.`);
    }
    return { changed, conflicts };
}

/**
 * One-time data fixes that must run before the server accepts requests.
 */
async function runStartupMigrations() {
    try {
        await ensureRoles();
    } catch (err) {
        console.error('❌ Role migration failed:', err);
    }
    try {
        await require('./orgService').migrateToOrganizations();
    } catch (err) {
        console.error('❌ Organization migration failed:', err);
    }
    try {
        await lowercaseEmails();
    } catch (err) {
        console.error('❌ Email normalization failed:', err);
    }
    try {
        const { groups } = await mergeDuplicateCameras({ apply: false });
        if (groups > 0) {
            console.warn(`⚠️ ${groups} camera serial(s) are registered more than once, so the unique index cannot be built. ` +
                'Run "node scripts/merge_duplicate_cameras.js" (preview) and then with --apply.');
        }
    } catch (err) {
        console.error('❌ Duplicate camera check failed:', err);
    }
}

module.exports = {
    ensureRoles,
    lowercaseEmails,
    mergeDuplicateCameras,
    runStartupMigrations
};
