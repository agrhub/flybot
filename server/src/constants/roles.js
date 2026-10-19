/**
 * System roles (User.role):
 *  admin    the platform operator: every workspace, every account, plans, system settings
 *  support  read-only access to the admin pages
 *  user     everyone else
 * "manager" is the retired global role (the workspaces-v1 migration moves it to "user"); a
 * legacy value still reads as a plain user. What a person may do with cameras, farms and
 * dashboards comes from their role in the current workspace (owner / manager / member,
 * services/workspaceService.js) and the workspace's plan (services/entitlements.js).
 */
const ROLES = ['admin', 'support', 'manager', 'user'];
const ASSIGNABLE_ROLES = ['admin', 'support', 'user'];

const roleOf = (user) => (ROLES.includes(user?.role) ? user.role : 'user');
const isAdmin = (user) => roleOf(user) === 'admin';
const isSupport = (user) => roleOf(user) === 'support';
// Owner or manager of the current workspace (req.user.workspace, set by middlewares/auth.js)
const worksInCurrentWorkspace = (user) => ['owner', 'manager'].includes(user?.workspace?.role);
const canAddCameras = (user) => isAdmin(user) || worksInCurrentWorkspace(user);
const canBuildDashboards = (user) => isAdmin(user) || worksInCurrentWorkspace(user);
// FlyBot Sentinel console (/api/sentinel/ui): whoever runs the current workspace decides approvals
// (for cameras they manage). An account an admin marked sentinelViewer (a competition judge)
// reads only, whatever it owns; a workspace member reads nothing
const canDecideSentinel = (user) => isAdmin(user) || (worksInCurrentWorkspace(user) && !user?.sentinelViewer && !user?.guest);
const canViewSentinel = (user) => canDecideSentinel(user) || !!user?.sentinelViewer;

module.exports = {
    ROLES,
    ASSIGNABLE_ROLES,
    roleOf,
    isAdmin,
    isSupport,
    canAddCameras,
    canBuildDashboards,
    canViewSentinel,
    canDecideSentinel
};
