import { openUpgradeDialog } from '@/composables/useUpgrade';
import axios from 'axios';
import i18n from '@/i18n';
import { ElMessage } from 'element-plus';
import { noteResponse, noteNetworkError } from '@/composables/useOffline';

const API_URL = '/api'; // Using the proxy

const apiClient = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // Server messages come back in the app's language
  config.headers['X-Language'] = i18n.global.locale.value;
  // The workspace the app shows (composables/useWorkspace.js); the server falls back to the saved one
  try {
    const workspaceId = localStorage.getItem('workspaceId');
    if (workspaceId) config.headers['X-Workspace-Id'] = workspaceId;
  } catch {
    // storage blocked: the server's saved workspace applies
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => {
    noteResponse(response);
    return response;
  },
  (error) => {
    // No answer at all: the device is offline (the service worker had no saved copy either)
    if (!error.response && error.code !== 'ERR_CANCELED') {
      noteNetworkError();
      // (unless the caller keeps the request to send later: it says so itself)
      if (error.config && error.config.method !== 'get' && !error.config.offlineQueue) {
        ElMessage.warning({ message: i18n.global.t('offline.needsNetwork'), grouping: true });
      }
    }
    // A plan limit: the upgrade dialog explains it and offers a request (components/plans/UpgradeDialog.vue)
    if (error.response?.status === 403 && error.response.data?.code === 'UPGRADE_REQUIRED' && !error.config?.skipUpgradeDialog) {
      openUpgradeDialog(error.response.data);
    }
    if (error.response && error.response.status === 401) {
      // Auth pages (login, reset password, verify email) handle their own errors
      if (!window.location.pathname.startsWith('/auth/')) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.href = '/auth/login';
      }
    }
    return Promise.reject(error);
  }
);

export default {
  // ---------- Workspaces, plans, upgrade requests ----------
  getWorkspaces() {
    return apiClient.get('/workspaces');
  },
  setCurrentWorkspace(workspaceId) {
    return apiClient.put('/workspaces/current', { workspaceId });
  },
  updateWorkspaceSettings(id, settings) {
    return apiClient.put(`/workspaces/${id}/settings`, settings);
  },
  getEntitlements() {
    return apiClient.get('/me/entitlements');
  },
  getPlans() {
    return apiClient.get('/plans');
  },
  createUpgradeRequest(data) {
    return apiClient.post('/upgrade-requests', data, { skipUpgradeDialog: true });
  },
  getUpgradeRequests() {
    return apiClient.get('/upgrade-requests');
  },
  cancelUpgradeRequest(id) {
    return apiClient.post(`/upgrade-requests/${id}/cancel`);
  },
  forwardUpgradeRequest(id, forward, note = '') {
    return apiClient.post(`/upgrade-requests/${id}/forward`, { forward, note });
  },
  adminGetPlans() {
    return apiClient.get('/admin/plans');
  },
  adminUpdatePlan(code, data) {
    return apiClient.put(`/admin/plans/${code}`, data);
  },
  adminGetWorkspaces(params = {}) {
    return apiClient.get('/admin/workspaces', { params });
  },
  adminCreateOrganization(data) {
    return apiClient.post('/admin/workspaces', data);
  },
  adminAssignPlan(id, data) {
    return apiClient.put(`/admin/workspaces/${id}/plan`, data);
  },
  adminGetUpgradeRequests(status = '') {
    return apiClient.get('/admin/upgrade-requests', { params: status ? { status } : {} });
  },
  adminApproveUpgrade(id, data) {
    return apiClient.post(`/admin/upgrade-requests/${id}/approve`, data);
  },
  adminRejectUpgrade(id, data) {
    return apiClient.post(`/admin/upgrade-requests/${id}/reject`, data);
  },

  // ---------- Online payment of plans (PayOS, Stripe) ----------
  getBilling() {
    return apiClient.get('/billing');
  },
  startCheckout(data) {
    return apiClient.post('/billing/checkout', data);
  },
  getPayments() {
    return apiClient.get('/billing/payments');
  },
  getPayment(id, { refresh = false } = {}) {
    return apiClient.get(`/billing/payments/${id}`, { params: refresh ? { refresh: 1 } : {} });
  },
  cancelRenewal() {
    return apiClient.post('/billing/cancel-renewal');
  },
  adminGetRevenue(params = {}) {
    return apiClient.get('/admin/revenue', { params });
  },

  login(email, password, language) {
    return apiClient.post('/auth/login', { email, password, language });
  },
  // The shared, read-only guest account (Admin > System > Demo access > Guest access)
  guestLogin() {
    return apiClient.post('/auth/guest');
  },
  getMe() {
    return apiClient.get('/auth/me');
  },
  getSessions() {
    return apiClient.get('/auth/sessions');
  },
  revokeSession(sessionId) {
    return apiClient.delete(`/auth/sessions/${sessionId}`);
  },
  // Signs out every other device; returns a fresh token for this one
  revokeOtherSessions() {
    return apiClient.post('/auth/sessions/revoke-others');
  },
  // Telegram alerts: one-time deep link to the bot, unlink, test message
  createTelegramLink() {
    return apiClient.post('/telegram/link');
  },
  unlinkTelegram() {
    return apiClient.delete('/telegram/link');
  },
  sendTelegramTest() {
    return apiClient.post('/telegram/test');
  },
  // Public sign-in page settings (e.g. whether registration is open)
  // Public contact form
  sendContact(data) {
    return apiClient.post('/public/contact', data);
  },
  // New camera with its trap kind ("sticky" | "lure")
  createCamera(data) {
    return apiClient.post('/user/add-camera', data);
  },
  getAuthConfig() {
    return apiClient.get('/auth/config');
  },
  // Administration (admin only)
  adminListUsers(params = {}) {
    return apiClient.get('/admin/users', { params });
  },
  adminUpdateUser(userId, data) {
    return apiClient.put(`/admin/users/${userId}`, data);
  },
  adminDeleteUser(userId) {
    return apiClient.delete(`/admin/users/${userId}`);
  },
  adminListCameras(params = {}) {
    return apiClient.get('/admin/cameras', { params });
  },
  adminTransferCamera(deviceSerial, email, keepPreviousOwnerAccess = true) {
    return apiClient.put(`/admin/cameras/${encodeURIComponent(deviceSerial)}/owner`, { email, keepPreviousOwnerAccess });
  },
  // Camera fleet, serial registry and firmware (admin)
  adminFleet(params = {}) {
    return apiClient.get('/admin/fleet', { params });
  },
  adminRevealCameraCode(deviceSerial) {
    return apiClient.post(`/admin/fleet/${encodeURIComponent(deviceSerial)}/reveal-code`);
  },
  adminSetCameraDisabled(deviceSerial, disabled, reason = '') {
    return apiClient.put(`/admin/fleet/${encodeURIComponent(deviceSerial)}/disabled`, { disabled, reason });
  },
  adminSetCameraChannel(serials, channel) {
    return apiClient.put('/admin/fleet/channel', { serials, channel });
  },
  adminRegistry(params = {}) {
    return apiClient.get('/admin/registry', { params });
  },
  adminAddRegistry(data) {
    return apiClient.post('/admin/registry', data);
  },
  adminUpdateRegistry(serial, data) {
    return apiClient.put(`/admin/registry/${encodeURIComponent(serial)}`, data);
  },
  adminDeleteRegistry(serial) {
    return apiClient.delete(`/admin/registry/${encodeURIComponent(serial)}`);
  },
  adminRevealRegistryCode(serial) {
    return apiClient.post(`/admin/registry/${encodeURIComponent(serial)}/reveal-code`);
  },
  adminImportRegistry(data) {
    return apiClient.post('/admin/registry/import', data);
  },
  adminBackfillRegistry() {
    return apiClient.post('/admin/registry/backfill');
  },
  adminFirmware() {
    return apiClient.get('/admin/firmware');
  },
  // FormData (file upload) or { url, model, version, sha256 } or { githubTag }
  adminAddFirmware(data) {
    const headers = typeof FormData !== 'undefined' && data instanceof FormData ? { 'Content-Type': 'multipart/form-data' } : {};
    return apiClient.post('/admin/firmware', data, { timeout: 180000, headers });
  },
  adminUpdateFirmware(id, data) {
    return apiClient.put(`/admin/firmware/${id}`, data);
  },
  adminDeleteFirmware(id) {
    return apiClient.delete(`/admin/firmware/${id}`);
  },
  adminRolloutFirmware(id, data) {
    return apiClient.post(`/admin/firmware/${id}/rollout`, data);
  },
  adminFirmwareUpdates(params = {}) {
    return apiClient.get('/admin/firmware/updates', { params });
  },
  adminCancelFirmwareUpdate(id) {
    return apiClient.post(`/admin/firmware/updates/${id}/cancel`);
  },
  adminRetryFirmwareUpdate(id) {
    return apiClient.post(`/admin/firmware/updates/${id}/retry`);
  },
  adminAuditLog(params = {}) {
    return apiClient.get('/admin/audit', { params });
  },
  // CSV file (needs the auth header, so it is fetched as a blob)
  exportAuditLog(params = {}) {
    return apiClient.get('/admin/audit/export', { params, responseType: 'blob' });
  },
  getAdminSettings() {
    return apiClient.get('/admin/settings');
  },
  // The simulated demo farm (scripts/demo_sim.js) as it stands (admin)
  adminDemoSim() {
    return apiClient.get('/admin/demo-sim');
  },
  // Capture pipeline monitor (admin)
  getPipeline() {
    return apiClient.get('/admin/pipeline');
  },
  // Roboflow retraining upload (admin)
  getTrainingSync() {
    return apiClient.get('/admin/training-sync');
  },
  runTrainingSync() {
    return apiClient.post('/admin/training-sync/run');
  },
  updateAdminSettings(data) {
    return apiClient.put('/admin/settings', data);
  },
  // Reports (custom dashboards)
  listDashboards() {
    return apiClient.get('/dashboards');
  },
  createDashboard(data) {
    return apiClient.post('/dashboards', data);
  },
  getDashboard(id) {
    return apiClient.get(`/dashboards/${id}`);
  },
  updateDashboard(id, data) {
    return apiClient.put(`/dashboards/${id}`, data);
  },
  deleteDashboard(id) {
    return apiClient.delete(`/dashboards/${id}`);
  },
  // query: { range, from?, to? } (utils/dashboards rangeQuery); none = the report's own range
  getDashboardData(id, query = null) {
    return apiClient.get(`/dashboards/${id}/data`, { params: query || {} });
  },
  rotateDashboardLink(id) {
    return apiClient.post(`/dashboards/${id}/public-token`);
  },
  shareDashboard(id, email) {
    return apiClient.post(`/dashboards/${id}/share`, { email });
  },
  // Email me the report with its PDF now (range: the one on screen, or null for the report's own)
  sendDashboardNow(id, range = null) {
    return apiClient.post(`/dashboards/${id}/send`, range ? { range } : {});
  },
  // Someone a report is shared with: stop or resume its scheduled emails for themselves
  muteDashboardSchedule(id, muted) {
    return apiClient.put(`/dashboards/${id}/schedule-mute`, { muted });
  },
  unshareDashboard(id, email) {
    return apiClient.delete(`/dashboards/${id}/share`, { data: { email } });
  },
  // Public dashboard link: no sign-in, so no token and no redirect on errors
  getPublicDashboard(token, query = null) {
    return axios.get(`${API_URL}/public/dashboards/${encodeURIComponent(token)}`, { params: query || {} });
  },
  // Web push on this device
  getPushConfig() {
    return apiClient.get('/push/config');
  },
  subscribePush(subscription) {
    return apiClient.post('/push/subscriptions', { subscription });
  },
  // token: on sign-out the stored token is already being cleared, so it is passed explicitly
  unsubscribePush(endpoint, token = null) {
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    return apiClient.delete('/push/subscriptions', { data: { endpoint }, headers });
  },
  sendTestPush() {
    return apiClient.post('/push/test');
  },
  getSystemInfo() {
    return apiClient.get('/system/info');
  },
  forgotPassword(email, language) {
    return apiClient.post('/auth/forgot-password', { email, language });
  },
  resetPassword(token, password) {
    return apiClient.post('/auth/reset-password', { token, password });
  },
  verifyEmail(token) {
    return apiClient.post('/auth/verify-email', { token });
  },
  resendVerification() {
    return apiClient.post('/auth/resend-verification');
  },
  logout() {
    // Clears the httpOnly image cookie on the server
    return apiClient.post('/auth/logout');
  },
  refreshSession() {
    // Sets the httpOnly image cookie from the stored Bearer token (sessions from before the cookie existed)
    return apiClient.post('/auth/session');
  },
  register(email, password, language) {
    return apiClient.post('/auth/register', { email, password, language });
  },
  changePassword(...args) {
    // Supports both (currentPassword, newPassword) and legacy (userId, currentPassword, newPassword)
    const currentPassword = args.length >= 3 ? args[1] : args[0];
    const newPassword = args.length >= 3 ? args[2] : args[1];
    return apiClient.post('/auth/change-password', { currentPassword, newPassword });
  },
  // "Download all my data" (ZIP)
  exportMyData() {
    return apiClient.get('/auth/export', { responseType: 'blob' });
  },
  uploadAvatar(blob) {
    return apiClient.post('/auth/avatar', blob, { headers: { 'Content-Type': 'image/jpeg' } });
  },
  deleteAvatar() {
    return apiClient.delete('/auth/avatar');
  },
  updateProfile(...args) {
    // Supports both (data) and legacy (userId, data)
    const data = args.length >= 2 ? args[1] : args[0];
    return apiClient.post('/auth/profile', data);
  },
  getCameras(params = {}) {
    const queryParams = typeof params === 'object' ? { ...params } : {};
    delete queryParams.userId;
    return apiClient.get('/user/cameras', { params: queryParams });
  },
  addCamera(...args) {
    // Supports both (deviceSerial, validateCode, deviceName) and legacy (userId, deviceSerial, validateCode, deviceName)
    let deviceSerial, validateCode, deviceName;
    if (args.length >= 3 && typeof args[1] === 'string' && typeof args[2] === 'string') {
      // Could be (userId, serial, code, name) or (serial, code, name)
      if (args.length >= 4 || args[0].length === 24) {
        deviceSerial = args[1];
        validateCode = args[2];
        deviceName = args[3] || '';
      } else {
        deviceSerial = args[0];
        validateCode = args[1];
        deviceName = args[2] || '';
      }
    } else {
      deviceSerial = args[0];
      validateCode = args[1];
      deviceName = args[2] || '';
    }
    return apiClient.post('/user/add-camera', { deviceSerial, validateCode, deviceName });
  },
  getThresholdSuggestions() {
    return apiClient.get('/user/cameras/threshold-suggestions');
  },
  updateCamera(...args) {
    // Supports both (deviceSerial, data) and legacy (userId, deviceSerial, data)
    const deviceSerial = args.length >= 3 ? args[1] : args[0];
    const data = args.length >= 3 ? args[2] : (args[1] || {});
    return apiClient.put('/user/camera', { deviceSerial, ...data });
  },
  updateCameraLocation(data = {}) {
    return apiClient.put('/user/camera/location', data);
  },
  deleteCamera(...args) {
    // Supports both (deviceSerial) and legacy (userId, deviceSerial)
    const deviceSerial = args.length >= 2 ? args[1] : args[0];
    return apiClient.delete('/user/delete-camera', { data: { deviceSerial } });
  },
  updateCameraCode(deviceSerial, validateCode) {
    return apiClient.post('/user/update-camera-code', { deviceSerial, validateCode });
  },
  // Capture, store and analyze a snapshot right now
  captureNow(deviceSerial) {
    return apiClient.post('/user/camera/capture', { deviceSerial });
  },
  // Camera sharing (owner/admin): view-only access by email, invitations for unknown emails
  getCameraShares(deviceSerial) {
    return apiClient.get('/user/camera/shares', { params: { deviceSerial } });
  },
  shareCamera(deviceSerial, email) {
    return apiClient.post('/user/camera/share', { deviceSerial, email });
  },
  unshareCamera(deviceSerial, email) {
    return apiClient.delete('/user/camera/share', { data: { deviceSerial, email } });
  },
  // Trap maintenance log (sticky card, lure, lens...)
  getMaintenance(deviceSerial, limit = 20) {
    return apiClient.get('/user/camera/maintenance', { params: { deviceSerial, limit } });
  },
  // config.offlineQueue: the caller keeps the request for later when there is no signal
  addMaintenance(data, config = {}) {
    return apiClient.post('/user/camera/maintenance', data, config);
  },
  deleteMaintenance(id) {
    return apiClient.delete(`/user/camera/maintenance/${id}`);
  },
  // API keys and webhooks
  listApiKeys() {
    return apiClient.get('/integrations/keys');
  },
  createApiKey(data) {
    return apiClient.post('/integrations/keys', data);
  },
  revokeApiKey(id) {
    return apiClient.delete(`/integrations/keys/${id}`);
  },
  listWebhooks() {
    return apiClient.get('/integrations/webhooks');
  },
  createWebhook(data) {
    return apiClient.post('/integrations/webhooks', data);
  },
  updateWebhook(id, data) {
    return apiClient.put(`/integrations/webhooks/${id}`, data);
  },
  deleteWebhook(id) {
    return apiClient.delete(`/integrations/webhooks/${id}`);
  },
  testWebhook(id) {
    return apiClient.post(`/integrations/webhooks/${id}/test`);
  },
  // Organizations
  getUsageStats() {
    return apiClient.get('/admin/usage');
  },
  listOrgs() {
    return apiClient.get('/orgs');
  },
  downloadCoopReport(id, params = {}) {
    return apiClient.get(`/orgs/${id}/report`, { params, responseType: 'blob' });
  },
  sendCoopReport(id, body = {}) {
    return apiClient.post(`/orgs/${id}/report/send`, body);
  },
  remindOrgMembers(id, userIds) {
    return apiClient.post(`/orgs/${id}/remind`, { userIds });
  },
  getOrgOverview(id, days) {
    return apiClient.get(`/orgs/${id}/overview`, { params: { days } });
  },
  createOrg(data) {
    return apiClient.post('/orgs', data);
  },
  updateOrg(id, data) {
    return apiClient.put(`/orgs/${id}`, data);
  },
  deleteOrg(id) {
    return apiClient.delete(`/orgs/${id}`);
  },
  remindInvitee(email) {
    return apiClient.post('/user/share/remind', { email });
  },
  remindOrgMember(id, email) {
    return apiClient.post(`/orgs/${id}/members/remind`, { email });
  },
  addOrgMembersBulk(id, data) {
    return apiClient.post(`/orgs/${id}/members/bulk`, data);
  },
  addOrgMember(id, data) {
    return apiClient.post(`/orgs/${id}/members`, data);
  },
  updateOrgMember(id, data) {
    return apiClient.put(`/orgs/${id}/members`, data);
  },
  removeOrgMember(id, data) {
    return apiClient.delete(`/orgs/${id}/members`, { data });
  },
  setOrgCameras(id, data) {
    return apiClient.put(`/orgs/${id}/cameras`, data);
  },
  // Farms and plots
  downloadSeasonReport(params = {}) {
    return apiClient.get('/farms/season-report', { params, responseType: 'blob' });
  },
  sendSeasonReport(body = {}) {
    return apiClient.post('/farms/season-report/send', body);
  },
  getSprayPlan() {
    return apiClient.get('/farms/plan');
  },
  compareFarms(days = 30) {
    return apiClient.get('/farms/compare', { params: { days } });
  },
  listFarms() {
    return apiClient.get('/farms');
  },
  createFarm(data) {
    return apiClient.post('/farms', data);
  },
  getFarm(id) {
    return apiClient.get(`/farms/${id}`);
  },
  updateFarm(id, data) {
    return apiClient.put(`/farms/${id}`, data);
  },
  deleteFarm(id) {
    return apiClient.delete(`/farms/${id}`);
  },
  createPlot(farmId, data) {
    return apiClient.post(`/farms/${farmId}/plots`, data);
  },
  updatePlot(farmId, plotId, data) {
    return apiClient.put(`/farms/${farmId}/plots/${plotId}`, data);
  },
  deletePlot(farmId, plotId) {
    return apiClient.delete(`/farms/${farmId}/plots/${plotId}`);
  },
  setPlotCameras(farmId, plotId, cameraSerials) {
    return apiClient.put(`/farms/${farmId}/plots/${plotId}/cameras`, { cameraSerials });
  },
  shareFarm(farmId, email) {
    return apiClient.post(`/farms/${farmId}/share`, { email });
  },
  unshareFarm(farmId, email) {
    return apiClient.delete(`/farms/${farmId}/share`, { data: { email } });
  },
  getFarmMap() {
    return apiClient.get('/farms/map');
  },
  // Treatment (IPM) log
  listWithholding() {
    return apiClient.get('/treatments/withholding');
  },
  sendVietGapRecord() {
    return apiClient.post('/treatments/vietgap/send');
  },
  getTreatmentEffectiveness(params = {}) {
    return apiClient.get('/treatments/effectiveness', { params });
  },
  listTreatments(params = {}) {
    return apiClient.get('/treatments', { params });
  },
  importTreatments(data) {
    return apiClient.post('/treatments/import', data);
  },
  createTreatment(data, config = {}) {
    return apiClient.post('/treatments', data, config);
  },
  updateTreatment(id, data) {
    return apiClient.put(`/treatments/${id}`, data);
  },
  deleteTreatment(id) {
    return apiClient.delete(`/treatments/${id}`);
  },
  getTreatmentEffect(id) {
    return apiClient.get(`/treatments/${id}/effect`);
  },
  getCamerasHealth() {
    return apiClient.get('/user/cameras/health');
  },
  getLiveStream(deviceSerial, urlId = '', quality = 1, protocol = 1) {
    return apiClient.post('/live', { deviceSerial, urlId, quality, protocol });
  },
  // Platform-aware camera endpoints (EZVIZ live URL shape, or the KVS viewer config for CamOS cameras)
  getCameraLive(deviceSerial) {
    return apiClient.get(`/cameras/${encodeURIComponent(deviceSerial)}/live`);
  },
  requestCameraLive(deviceSerial, minutes = 5) {
    return apiClient.post(`/cameras/${encodeURIComponent(deviceSerial)}/live/request`, { minutes });
  },
  getCameraPlayback(deviceSerial, from, to) {
    return apiClient.get(`/cameras/${encodeURIComponent(deviceSerial)}/playback`, { params: { from, to } });
  },
  // camos-esp32-trap remote settings (services/camosSettings.js on the server)
  getDeviceSettings(deviceSerial) {
    return apiClient.get(`/cameras/${encodeURIComponent(deviceSerial)}/device-settings`);
  },
  updateDeviceSettings(deviceSerial, changes) {
    return apiClient.put(`/cameras/${encodeURIComponent(deviceSerial)}/device-settings`, { changes });
  },
  // One console action on a camos-esp32-trap camera: refresh | locate | restart | wifi {ssid, password} | apn {apn}
  cameraDeviceAction(deviceSerial, body) {
    return apiClient.post(`/cameras/${encodeURIComponent(deviceSerial)}/device-action`, body);
  },
  // Battery history of a CamOS camera over the last 1..30 days: readings, charging periods, rate of change
  getPowerHistory(deviceSerial, days = 1) {
    return apiClient.get(`/cameras/${encodeURIComponent(deviceSerial)}/power-history`, { params: { days } });
  },
  // Firmware: running and latest version, check, confirmed install, automatic updates
  getCameraFirmware(deviceSerial) {
    return apiClient.get(`/cameras/${encodeURIComponent(deviceSerial)}/firmware`);
  },
  checkCameraFirmware(deviceSerial) {
    return apiClient.post(`/cameras/${encodeURIComponent(deviceSerial)}/firmware/check`);
  },
  updateCameraFirmware(deviceSerial) {
    return apiClient.post(`/cameras/${encodeURIComponent(deviceSerial)}/firmware/update`, { confirm: true });
  },
  setCameraFirmwareAuto(deviceSerial, enabled, hour) {
    return apiClient.put(`/cameras/${encodeURIComponent(deviceSerial)}/firmware/auto`, { enabled, ...(hour !== undefined ? { hour } : {}) });
  },
  // Remote console log (CamOS): lines, on / off, live lines while watching, download, crash reports
  getCameraLog(deviceSerial, params = {}) {
    return apiClient.get(`/cameras/${encodeURIComponent(deviceSerial)}/log`, { params });
  },
  startCameraLog(deviceSerial, level, minutes) {
    return apiClient.post(`/cameras/${encodeURIComponent(deviceSerial)}/log/start`, { level, minutes });
  },
  stopCameraLog(deviceSerial) {
    return apiClient.post(`/cameras/${encodeURIComponent(deviceSerial)}/log/stop`);
  },
  watchCameraLog(deviceSerial, watching = true) {
    return apiClient.post(`/cameras/${encodeURIComponent(deviceSerial)}/log/watch`, { watching });
  },
  downloadCameraLog(deviceSerial) {
    return apiClient.get(`/cameras/${encodeURIComponent(deviceSerial)}/log/download`, { responseType: 'blob' });
  },
  getCameraCrashes(deviceSerial) {
    return apiClient.get(`/cameras/${encodeURIComponent(deviceSerial)}/crashes`);
  },
  getCameraStatus(deviceSerial) {
    return apiClient.get(`/cameras/${encodeURIComponent(deviceSerial)}/status`);
  },
  // A self-registered CamOS camera (public firmware): take it over with its serial and label code
  claimCamera(data) {
    return apiClient.post('/cameras/claim', data);
  },
  // CamOS cameras: a new provisioning token for the camera's portal
  provisionCamera(deviceSerial) {
    return apiClient.post('/user/camera/provision', { deviceSerial });
  },
  disableStream(deviceSerial, urlId = '', channelNo = 1) {
    return apiClient.post('/live/disable', { deviceSerial, channelNo, urlId });
  },
  getRecords(deviceSerial, startTime, endTime) {
    return apiClient.post('/records', { deviceSerial, startTime, endTime });
  },
  getPlaybackStream(deviceSerial, startTime, stopTime, urlId = '') {
    return apiClient.post('/playback', { deviceSerial, startTime, stopTime, urlId });
  },
  getAiResults(deviceSerial = 'all', page = 1, limit = 10, startDate = null, endDate = null) {
    const params = new URLSearchParams();
    if (deviceSerial) params.append('deviceSerial', deviceSerial);
    params.append('page', page);
    params.append('limit', limit);
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    return apiClient.get(`/ai/results?${params.toString()}`);
  },
  // Detection history with filters: { deviceSerials: [], startDate, endDate, risk, review, page, limit }
  getHistory({ deviceSerials = [], page = 1, limit = 10, startDate = null, endDate = null, risk = null, review = null } = {}) {
    const params = { page, limit };
    if (deviceSerials.length) params.deviceSerials = deviceSerials.join(',');
    if (startDate) params.startDate = startDate;
    if (endDate) params.endDate = endDate;
    if (risk) params.risk = risk;
    if (review) params.review = review;
    return apiClient.get('/ai/results', { params });
  },
  getStatistics(deviceSerial = 'all', mode = 'hour', startDate = null, endDate = null, metric = null) {
    const params = new URLSearchParams();
    // metric "catches": insects caught per day instead of the count on the traps
    if (metric) params.append('metric', metric);
    if (deviceSerial) params.append('deviceSerial', deviceSerial);
    if (mode) params.append('mode', mode);
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    return apiClient.get(`/ai/statistics?${params.toString()}`);
  },
  // Analytics insights: per-trap table, daily catches, activity by hour, temperatures
  getInsights(deviceSerial = 'all', days = 14) {
    return apiClient.get('/ai/insights', { params: { deviceSerial, days } });
  },
  // This period vs the previous one, overall and per camera (days: 7 | 14 | 30)
  getComparison(days = 7, deviceSerials = []) {
    return apiClient.get('/ai/comparison', { params: { days, ...(deviceSerials.length ? { deviceSerials: deviceSerials.join(',') } : {}) } });
  },
  // Human review of an AI result: { status: 'confirmed' } or { status: 'corrected', summary, note }
  reviewSnapshot(snapshotId, body) {
    return apiClient.put(`/ai/snapshots/${snapshotId}/review`, body);
  },
  // Corrected snapshots (model output vs human counts) for retraining
  exportReviews(days = 90) {
    return apiClient.get('/ai/reviews/export', { params: { days } });
  },
  getAiOverview() {
    return apiClient.get('/ai/overview');
  },
  getAiDiagnosis(data = {}) {
    return apiClient.post('/ai/diagnose', data);
  },
  chatWithAssistant(message, sessionId = 'default-session', uiContext = {}) {
    return apiClient.post('/ai/chat', { message, sessionId, uiContext });
  },
  clearChatSession(sessionId = 'default-session') {
    return apiClient.post('/ai/chat/clear', { sessionId });
  },
  /**
   * The assistant's answer as it is written (server-sent events over fetch, since EventSource
   * cannot POST). onEvent(type, data) gets turn, delta, tool; resolves with the done payload.
   * Rejects with err.streamUnavailable when nothing could be read, so the caller can fall back.
   */
  async chatWithAssistantStream(message, sessionId, uiContext, onEvent) {
    const token = localStorage.getItem('token');
    const res = await fetch(`${API_URL}/ai/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Language': i18n.global.locale.value,
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ message, sessionId, uiContext })
    });
    if (!res.ok || !res.body || !(res.headers.get('content-type') || '').includes('text/event-stream')) {
      const err = new Error(`Chat stream failed (${res.status})`);
      err.streamUnavailable = true;
      err.status = res.status;
      throw err;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        const payload = JSON.parse(data);
        if (event === 'done') result = payload;
        else if (event === 'error') {
          // A message from the server, in the user's language
          const err = new Error(payload.message || 'Chat failed');
          err.fromServer = true;
          throw err;
        }
        else onEvent(event, payload);
      }
    }
    if (!result) throw new Error('The answer was cut off');
    return result;
  },
  getChatHistory(sessionId) {
    return apiClient.get('/ai/chat/history', { params: { sessionId } });
  },
  confirmChatAction(sessionId, messageId, cardIndex, decision) {
    return apiClient.post('/ai/chat/confirm', { sessionId, messageId, cardIndex, decision });
  },
  rateChatMessage(sessionId, messageId, rating) {
    return apiClient.post('/ai/chat/feedback', { sessionId, messageId, rating });
  },
  getNotifications(params = {}) {
    return apiClient.get('/notifications', { params });
  },
  // Weekly report: send mine now (email / Telegram / push)
  sendWeeklyReport() {
    return apiClient.post('/notifications/weekly-report');
  },
  markNotificationsRead(ids) {
    return apiClient.post('/notifications/read', ids === 'all' ? { all: true } : { ids });
  },
  // SSE endpoint; authenticated by the httpOnly cookie
  notificationStreamUrl: '/api/notifications/stream',
  // FlyBot Sentinel console: the server proxies the Sentinel UI API (503 SENTINEL_DISABLED when
  // it is not set up). `path` is e.g. 'summary', 'traces', 'traces/<id>'.
  sentinelGet(path, params = {}) {
    return apiClient.get(`/sentinel/ui/${path}`, { params });
  },
  // The server adds who decided; viewers get 403
  sentinelDecide(approvalId, decision) {
    return apiClient.post(`/sentinel/ui/approvals/${encodeURIComponent(approvalId)}/decide`, { decision });
  },
  // Evidence picture (the httpOnly cookie authenticates the <img> request, as for /api/s3)
  sentinelEvidenceUrl(key) {
    if (!key) return '';
    if (/^https?:\/\//.test(key)) return key;
    return `/api/sentinel/ui/evidence?key=${encodeURIComponent(key)}`;
  },
  getImageUrl(urlOrKey) {
    if (!urlOrKey) return '';
    if (urlOrKey.startsWith('http://') || urlOrKey.startsWith('https://')) {
      return urlOrKey;
    }
    const clean = urlOrKey.startsWith('/') ? urlOrKey : `/${urlOrKey}`;
    return `/api/s3${clean}`;
  }
};
