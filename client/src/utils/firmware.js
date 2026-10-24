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

/**
 * The version an ESP32 application image carries (esp_app_desc_t.version, right after the image and first segment
 * headers), or '' when the bytes are not such an image. A leading "v" is dropped.
 */
export function imageVersion(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length < 80 || b[0] !== 0xe9) return '';
  // esp_app_desc_t.magic_word 0xABCD5432 (little endian) at 32, version[32] at 48
  if (b[32] !== 0x32 || b[33] !== 0x54 || b[34] !== 0xcd || b[35] !== 0xab) return '';
  let end = 48;
  while (end < 80 && b[end] !== 0) end++;
  return String.fromCharCode(...b.subarray(48, end)).trim().replace(/^v/i, '');
}
