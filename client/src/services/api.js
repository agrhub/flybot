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
