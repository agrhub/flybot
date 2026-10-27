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

/**
 * What a camera's tag says: 'online', 'sleeping' or 'offline'. A CamOS camera that said goodbye before a planned
 * sleep is sleeping until its wake time has passed (the rule of the server's fleet state), not offline.
 */
export function cameraState(cam, now = Date.now()) {
  const d = cam?.device;
  if (platformOf(cam) === 'camos' && d?.sleeping && (!d.wakeAt || new Date(d.wakeAt).getTime() > now)) return 'sleeping';
  return cam?.status === 1 ? 'online' : 'offline';
}

/**
 * A camera seen awake (its live view plays): online and no longer sleeping in the page's copy, so its tag and the
 * camera list stop saying "Sleeping, next wake ..." until the list is loaded again.
 */
export function markAwake(cam) {
  if (!cam) return;
  cam.status = 1;
  if (cam.device?.sleeping) cam.device.sleeping = false;
}

/** When a sleeping camera next wakes (the planned wake, else the one the server expects), or null. */
export const nextWakeOf = (cam) => cam?.device?.nextWakeAt || cam?.device?.wakeAt || null;

/** The state's words: Online, Offline, or Sleeping with the next wake time. */
export function cameraStateLabel(cam, t, now = Date.now()) {
  const state = cameraState(cam, now);
  if (state !== 'sleeping') return t(`common.${state}`);
  const at = nextWakeOf(cam);
  return at ? t('cameras.sleepingNextWake', { time: new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : t('cameras.sleeping');
}

/** The Element Plus tag type of each state: a sleeping camera is not a fault. */
export const STATE_TAG = { online: 'success', sleeping: 'info', offline: 'danger' };
