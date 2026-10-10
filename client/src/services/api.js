import axios from 'axios';

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
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
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
  login(email, password, language) {
    return apiClient.post('/auth/login', { email, password, language });
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
  updateAdminSettings(data) {
    return apiClient.put('/admin/settings', data);
  },
  // Custom dashboards
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
  getDashboardData(id) {
    return apiClient.get(`/dashboards/${id}/data`);
  },
  rotateDashboardLink(id) {
    return apiClient.post(`/dashboards/${id}/public-token`);
  },
  shareDashboard(id, email) {
    return apiClient.post(`/dashboards/${id}/share`, { email });
  },
  unshareDashboard(id, email) {
    return apiClient.delete(`/dashboards/${id}/share`, { data: { email } });
  },
  // Public dashboard link: no sign-in, so no token and no redirect on errors
  getPublicDashboard(token) {
    return axios.get(`${API_URL}/public/dashboards/${encodeURIComponent(token)}`);
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
  addMaintenance(data) {
    return apiClient.post('/user/camera/maintenance', data);
  },
  deleteMaintenance(id) {
    return apiClient.delete(`/user/camera/maintenance/${id}`);
  },
  // Farms and plots
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
  listTreatments(params = {}) {
    return apiClient.get('/treatments', { params });
  },
  createTreatment(data) {
    return apiClient.post('/treatments', data);
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
  getStatistics(deviceSerial = 'all', mode = 'hour', startDate = null, endDate = null) {
    const params = new URLSearchParams();
    if (deviceSerial) params.append('deviceSerial', deviceSerial);
    if (mode) params.append('mode', mode);
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    return apiClient.get(`/ai/statistics?${params.toString()}`);
  },
  // This period vs the previous one, overall and per camera (days: 7 | 14 | 30)
  getComparison(days = 7) {
    return apiClient.get('/ai/comparison', { params: { days } });
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
  getImageUrl(urlOrKey) {
    if (!urlOrKey) return '';
    if (urlOrKey.startsWith('http://') || urlOrKey.startsWith('https://')) {
      return urlOrKey;
    }
    const clean = urlOrKey.startsWith('/') ? urlOrKey : `/${urlOrKey}`;
    return `/api/s3${clean}`;
  }
};
