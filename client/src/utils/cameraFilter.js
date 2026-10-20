/**
 * Camera list filter (the cameras page and the detail view's switcher): free text over name, serial and model, the
 * online state, the platform (ezviz / camos), the trap kind (sticky / lure) and the source (real / simulated demo).
 * Kept pure for tests.
 */
const platformOf = (cam) => (cam?.platform === 'camos' || cam?.platform === 'kinesis' ? 'camos' : 'ezviz');

// Lower case without Vietnamese accents, so "vinh long" finds "Vĩnh Long"
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

export function filterCameras(cameras, { query = '', status = 'all', type = 'all', kind = 'all', source = 'all' } = {}) {
  const q = fold(query).trim();
  return (cameras || []).filter((cam) => {
    if (status === 'online' && cam.status !== 1) return false;
    if (status === 'offline' && cam.status === 1) return false;
    if (type !== 'all' && platformOf(cam) !== type) return false;
    if (kind !== 'all' && (cam.trapKind || 'sticky') !== kind) return false;
    if (source === 'real' && cam.simulated) return false;
    if (source === 'simulated' && !cam.simulated) return false;
    if (!q) return true;
    return [cam.deviceName, cam.deviceSerial, cam.model, cam.deviceType].some((v) => fold(v).includes(q));
  });
}
