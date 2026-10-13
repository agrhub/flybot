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

module.exports = {
    ROLES,
    roleOf,
    isAdmin,
    canAddCameras,
    canBuildDashboards
};
