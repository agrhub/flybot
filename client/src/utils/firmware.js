// Firmware helpers shared by the admin fleet / firmware panels and the camera's firmware card

/** Numeric compare of dotted versions ("0.10.0" > "0.9.3"); a pre-release suffix sorts before the release. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+(?:\.\d+)*)(?:[-+.]?(.*))?$/);
    return m ? { nums: m[1].split('.').map(Number), pre: m[2] || '' } : { nums: [], pre: String(v || '') };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

// el-tag type of each update state (models/FirmwareUpdate.js on the server)
const STATE_TYPES = {
  pending: 'info',
  sent: 'primary',
  installing: 'primary',
  rebooting: 'primary',
  succeeded: 'success',
  failed: 'danger',
  rolled_back: 'danger',
  cancelled: 'info'
};
export const OPEN_STATES = ['pending', 'sent', 'installing', 'rebooting'];

// Release channels (server services/firmwareChannels.js): alpha -> beta -> stable
export const CHANNELS = ['alpha', 'beta', 'stable'];
const CHANNEL_TYPES = { alpha: 'danger', beta: 'warning', stable: 'success' };

export function channelTagType(channel) {
  return CHANNEL_TYPES[channel] || 'success';
}

/** The channel a release is promoted to next, or null for stable. */
export function nextChannel(channel) {
  return { alpha: 'beta', beta: 'stable' }[channel] || null;
}

export function updateTagType(state) {
  return STATE_TYPES[state] || 'info';
}

export function isOpenUpdate(update) {
  return !!update && OPEN_STATES.includes(update.state);
}

/** Bytes as "1.2 MB" / "640 KB". */
export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/**
 * Progress of an update for an el-progress bar (0-100), or null when there is nothing to show yet.
 * Firmware 0.7.0+ reports download progress; older firmware jumps from installing to rebooting.
 */
export function updateProgress(update) {
  if (!update) return null;
  if (update.state === 'succeeded') return 100;
  if (update.state === 'rebooting') return 95;
  if (update.state === 'installing') return Math.min(90, Math.max(5, Math.round((update.progress ?? 0) * 0.9)));
  if (update.state === 'sent') return 2;
  return null;
}
