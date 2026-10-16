const { Organization, User, Camera, Farm, Dashboard } = require('../models');
const workspaceService = require('./workspaceService');

/**
 * One-time move to workspaces and plans (migrations.runOnce "workspaces-v1"; idempotent, and
 * it never deletes anything):
 *  - existing organizations become kind "organization" on ENTERPRISE (note "grandfathered");
 *  - each account gets a personal workspace (APP_MODE b2c / hybrid): FREE, or for a former
 *    "manager" PRO (ENTERPRISE when they own more than 10 cameras), note "grandfathered";
 *  - "manager" accounts become "user" (what they did with cameras now comes from owning their
 *    workspaces); admins stay admins;
 *  - cameras, farms and dashboards outside any workspace move into their owner's personal one;
 *    cameras shared with someone stay shared (as shares, not ownership);
 *  - organizations keep their members and roles.
 * planWorkspaceMigration() lists what would change (logged first, the "dry run"); apply runs it.
 */
const GRANDFATHERED = 'grandfathered';

async function planWorkspaceMigration() {
    const orgs = Organization.collection;
    const users = User.collection;
    const orgsToMark = await orgs.countDocuments({ kind: { $exists: false } });
    const managers = await users.find({ role: 'manager' }).project({ _id: 1, email: 1 }).toArray();
    const personalOwners = new Set((await orgs.find({ kind: 'personal' }).project({ members: 1 }).toArray())
        .map(o => String(o.members?.find(m => m.role === 'owner')?.userId || '')));
    const allUsers = await users.find({}).project({ _id: 1, email: 1, role: 1 }).toArray();
    const needPersonal = workspaceService.personalAllowed() ? allUsers.filter(u => !personalOwners.has(String(u._id))).length : 0;
    const [cameras, farms, dashboards] = await Promise.all([
        Camera.collection.countDocuments({ orgId: null, userId: { $ne: null } }),
        Farm.collection.countDocuments({ orgId: null, ownerId: { $ne: null } }),
        Dashboard.collection.countDocuments({ orgId: null })
    ]);
    return {
        mode: workspaceService.mode(),
        organizationsToMark: orgsToMark,
        managersToUser: managers.length,
        personalWorkspacesToCreate: needPersonal,
        camerasToMove: workspaceService.personalAllowed() ? cameras : 0,
        farmsToMove: workspaceService.personalAllowed() ? farms : 0,
        dashboardsToMove: workspaceService.personalAllowed() ? dashboards : 0
    };
}

async function migrateToWorkspaces({ now = new Date(), log = console } = {}) {
    const plan = await planWorkspaceMigration();
    log.log(`🧭 Workspaces migration (APP_MODE=${plan.mode}), dry run: ${JSON.stringify(plan)}`);

    // 1. Existing organizations: kind organization, ENTERPRISE, grandfathered (raw: no defaults read in)
    const marked = await Organization.collection.updateMany(
        { kind: { $exists: false } },
        { $set: { kind: 'organization', plan: { code: 'enterprise', addonCameras: 0, expiresAt: null, assignedBy: null, assignedAt: now, note: GRANDFATHERED } } }
    );

    // 2. Accounts: personal workspaces, managers -> user, orphan items into the personal workspace
    const users = await User.collection.find({}).project({ _id: 1, email: 1, name: 1, role: 1 }).toArray();
    let personalCreated = 0;
    let managers = 0;
    let moved = { cameras: 0, farms: 0, dashboards: 0 };
    for (const u of users) {
        const wasManager = u.role === 'manager';
        let personal = null;
        if (workspaceService.personalAllowed()) {
            const existed = await Organization.exists({ kind: 'personal', members: { $elemMatch: { userId: u._id, role: 'owner' } } });
            personal = await workspaceService.ensurePersonal({ _id: u._id, email: u.email, name: u.name });
            if (!existed) personalCreated++;
            if (wasManager) {
                const owned = await Camera.countDocuments({ userId: u._id });
                const code = owned > 10 ? 'enterprise' : 'pro';
                if (personal.plan?.code === 'free' || !personal.plan?.code) {
                    await Organization.updateOne({ _id: personal._id }, { $set: { plan: { code, addonCameras: 0, expiresAt: null, assignedBy: null, assignedAt: now, note: GRANDFATHERED } } });
                }
            }
            const [c, f, d] = await Promise.all([
                Camera.updateMany({ userId: u._id, orgId: null }, { $set: { orgId: personal._id } }),
                Farm.updateMany({ ownerId: u._id, orgId: null }, { $set: { orgId: personal._id } }),
                Dashboard.updateMany({ ownerId: u._id, orgId: null }, { $set: { orgId: personal._id } })
            ]);
            moved = { cameras: moved.cameras + c.modifiedCount, farms: moved.farms + f.modifiedCount, dashboards: moved.dashboards + d.modifiedCount };
        }
        if (wasManager) {
            await User.collection.updateOne({ _id: u._id, role: 'manager' }, { $set: { role: 'user' } });
            managers++;
        }
    }

    const result = { organizations: marked.modifiedCount, personalCreated, managersToUser: managers, ...moved };
    log.log(`🧭 Workspaces migration done: ${JSON.stringify(result)}`);
    require('./auditService').recordAudit(null, {
        action: 'system.workspaces_migrated',
        actor: { email: 'system' },
        target: { type: 'system', id: 'workspaces-v1', label: 'workspaces-v1' },
        details: { mode: plan.mode, ...result }
    });
    return result;
}

module.exports = {
    GRANDFATHERED,
    planWorkspaceMigration,
    migrateToWorkspaces
};
