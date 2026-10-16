/**
 * Account roles.
 *  admin   – full control: every camera, every account, system settings
 *  manager – adds cameras, manages and shares the cameras they own, builds dashboards
 *  user    – views cameras and dashboards shared with them; cannot add or change cameras
 */
const ROLES = ['admin', 'manager', 'user'];

const roleOf = (user) => (ROLES.includes(user?.role) ? user.role : 'user');
const isAdmin = (user) => roleOf(user) === 'admin';
const canAddCameras = (user) => ['admin', 'manager'].includes(roleOf(user));
const canBuildDashboards = (user) => ['admin', 'manager'].includes(roleOf(user));
// FlyBot Sentinel console (/api/sentinel/ui): admins and managers read and decide approvals;
// a "user" account reads only, and only when an admin turned sentinelViewer on (e.g. a judge)
const canDecideSentinel = (user) => ['admin', 'manager'].includes(roleOf(user));
const canViewSentinel = (user) => canDecideSentinel(user) || !!user?.sentinelViewer;

module.exports = {
    ROLES,
    roleOf,
    isAdmin,
    canAddCameras,
    canBuildDashboards,
    canViewSentinel,
    canDecideSentinel
};
