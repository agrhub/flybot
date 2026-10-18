/**
 * Camera list filter of the detail view's switcher: free text over name, serial and model, the online state and
 * the platform (ezviz / camos). Kept pure for tests.
 */
const platformOf = (cam) => (cam?.platform === 'camos' || cam?.platform === 'kinesis' ? 'camos' : 'ezviz');

// Lower case without Vietnamese accents, so "vinh long" finds "Vĩnh Long"
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

export function filterCameras(cameras, { query = '', status = 'all', type = 'all' } = {}) {
  const q = fold(query).trim();
  return (cameras || []).filter((cam) => {
    if (status === 'online' && cam.status !== 1) return false;
    if (status === 'offline' && cam.status === 1) return false;
    if (type !== 'all' && platformOf(cam) !== type) return false;
    if (!q) return true;
    return [cam.deviceName, cam.deviceSerial, cam.model, cam.deviceType].some((v) => fold(v).includes(q));
  });
}
