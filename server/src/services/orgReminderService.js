const { Organization, User } = require('../models');
const notificationService = require('./notificationService');
const { orgOverview } = require('./orgOverviewService');

/**
 * A cooperative following up its growers:
 *  - remindMembers: an owner or manager asks members to check their traps and log what they
 *    did (from the cooperative overview); each member gets it at most once a day.
 *  - sendOrgDigests: every Monday, owners and managers get the members to visit (traps at
 *    their threshold, nothing logged in the past week), unless they turned it off.
 */
const MAX_NAMES = 5;
const nameOf = (m) => m.name || m.email;

async function remindMembers(org, sender, userIds) {
    const overview = await orgOverview(org, 7);
    const byId = new Map(overview.members.filter(m => m.userId).map(m => [m.userId, m]));
    const results = [];
    for (const userId of userIds) {
        const member = byId.get(userId);
        // Only members with traps here: a reminder about nothing helps no one
        if (!member || !member.cameras) {
            results.push({ userId, status: 'skipped' });
            continue;
        }
        const sent = await notificationService.notifyUser({
            userId,
            type: 'log_reminder',
            // Scopes the once-a-day limit to this organization
            deviceSerial: `org:${org._id}`,
            params: { orgName: org.name, sender: sender.name || sender.email, atThreshold: member.atThreshold, cameras: member.cameras }
        });
        results.push({ userId, status: sent ? 'sent' : 'already' });
    }
    return results;
}

/** Monday digest for each organization's owners and managers (returns how many were sent). */
async function sendOrgDigests() {
    let sent = 0;
    const orgs = await Organization.find({ 'members.1': { $exists: true } });
    for (const org of orgs) {
        const overview = await orgOverview(org, 7);
        const toVisit = overview.members.filter(m => m.needsVisit);
        if (!toVisit.length) continue;
        const leads = org.members.filter(m => m.userId && (m.role === 'owner' || m.role === 'manager')).map(m => m.userId);
        const users = await User.find({ _id: { $in: leads }, disabled: { $ne: true }, 'notificationPrefs.orgDigest': { $ne: false } }).select('_id');
        const names = toVisit.slice(0, MAX_NAMES).map(nameOf).join(', ') + (toVisit.length > MAX_NAMES ? ` (+${toVisit.length - MAX_NAMES})` : '');
        for (const user of users) {
            const done = await notificationService.notifyUser({
                userId: user._id,
                type: 'org_digest',
                deviceSerial: `org:${org._id}`,
                params: { orgName: org.name, count: toVisit.length, names, ftd: overview.totals.ftd ?? '--' }
            });
            if (done) sent++;
        }
    }
    return { sent };
}

module.exports = {
    remindMembers,
    sendOrgDigests
};
