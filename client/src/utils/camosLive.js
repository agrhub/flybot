/**
 * CamOS live view over the "camos" WebRTC data channel (camos-esp32-trap docs/dev/LIVE_VIEW.md, "Data channel"):
 * the camera sends either H.264 on the video track (default) or, when asked, JPEG frames from the sensor over the data
 * channel. Text messages are JSON control messages; binary messages are JPEG chunks behind a 20-byte header:
 *   'C' 'J' version(1) headerLength(20) | seq u32 | total u32 | offset u32 | ts u32   (little endian)
 * The viewer reassembles each frame, drops a frame that a newer one overtakes before it is complete, and
 * acknowledges every complete frame ({"t":"ack","seq":n}): the camera keeps at most two frames unacknowledged.
 * The channel is partially reliable (CHANNEL_OPTIONS), so a quality request is repeated until the camera confirms it.
 */

export const CAMOS_CHANNEL = 'camos';
// Unordered, and a chunk not delivered within 300 ms is given up: esp_peer's fully reliable SCTP stalls for seconds
// after a loss on a busy Wi-Fi, while a lost chunk here only costs one frame (and a lost ack, one ack timeout)
export const CHANNEL_OPTIONS = { ordered: false, maxPacketLifeTime: 300 };
export const HEADER_LENGTH = 20;

/**
 * Quality choices of the live view. JPEG over the data channel is the normal mode (the camera's own JPEG encoder:
 * more detail and frames than software H.264); `low` is H.264 320x240 for a weak link. The JPEG sizes come from the
 * camera (its `hello` lists the sizes its sensor can stream), as `jpeg-<w>x<h>` choices; `auto` takes 640x480 when
 * the camera offers it, else the size closest to it. `medium` / `high` are older saved choices (640x480, 1024x768).
 */
export const QUALITY_PRESETS = {
  low: { mode: 'h264', w: 320, h: 240, fps: 10 },
  medium: { mode: 'jpeg', w: 640, h: 480, q: 12, fps: 15 },
  high: { mode: 'jpeg', w: 1024, h: 768, q: 12, fps: 10 },
};
export const QUALITY_CHOICES = ['auto', 'low', 'medium', 'high'];
const STORAGE_KEY = 'flybot.camosLiveQuality';
const JPEG_CHOICE = /^jpeg-(\d{2,5})x(\d{2,5})$/;
const AUTO_AREA = 640 * 480;

/** A JPEG preset for one size: 15 fps up to VGA, 10 above (what the board sustains). */
export function jpegPreset(w, h) {
  return { mode: 'jpeg', w, h, q: 12, fps: w * h <= AUTO_AREA ? 15 : 10 };
}

/** The menu for a camera's live sizes ([[w, h], ...] from its hello): auto, low, then each JPEG size, small first. */
export function qualityChoices(sizes) {
  const jpeg = (Array.isArray(sizes) ? sizes : [])
    .filter((s) => Array.isArray(s) && s[0] > 320 && s[1] > 0)
    .sort((a, b) => a[0] * a[1] - b[0] * b[1])
    .map(([w, h]) => `jpeg-${w}x${h}`);
  return jpeg.length ? ['auto', 'low', ...jpeg] : QUALITY_CHOICES;
}

/** The [w, h] of a choice (jpeg-WxH, medium, high), or null. */
export function sizeOf(choice) {
  const m = JPEG_CHOICE.exec(String(choice || ''));
  if (m) return [Number(m[1]), Number(m[2])];
  if (choice === 'medium') return [640, 480];
  if (choice === 'high') return [1024, 768];
  return null;
}

/** The preset a choice asks the camera for, or null for plain H.264 without a data channel. */
export function presetFor(choice, channelOpen, sizes = null) {
  if (!channelOpen) return null;
  if (choice === 'low') return QUALITY_PRESETS.low;
  const offered = Array.isArray(sizes) && sizes.length ? sizes.filter((s) => Array.isArray(s) && s[0] > 320) : null;
  const asked = sizeOf(choice);
  if (asked && !offered && QUALITY_PRESETS[choice]) return QUALITY_PRESETS[choice]; // medium / high, sizes unknown
  if (asked) {
    // A size this camera does not stream falls back to the closest one it does
    if (!offered || offered.some(([w, h]) => w === asked[0] && h === asked[1])) return jpegPreset(asked[0], asked[1]);
    return jpegPreset(...closest(offered, asked[0] * asked[1]));
  }
  if (!offered) return QUALITY_PRESETS.medium; // auto with an older camera that does not list its sizes
  return jpegPreset(...closest(offered, AUTO_AREA));
}

/**
 * Whether what plays ({ mode, width, height } of the viewer's info) is not the preset asked for: the camera lowered
 * the quality on a weak link, could not start the asked size, or never opened the data channel.
 */
export function qualityDiffers(preset, info) {
  if (!preset || !info?.width) return false;
  if (info.mode !== preset.mode) return true;
  return preset.mode === 'jpeg' && (info.width !== preset.w || info.height !== preset.h);
}

function closest(sizes, area) {
  return sizes.reduce((best, s) => (Math.abs(s[0] * s[1] - area) < Math.abs(best[0] * best[1] - area) ? s : best), sizes[0]);
}

export function qualityMessage(preset) {
  const { mode, w, h, q, fps } = preset;
  return JSON.stringify({ t: 'quality', mode, w, h, ...(q ? { q } : {}), fps });
}

export const ackMessage = (seq) => JSON.stringify({ t: 'ack', seq });

/** A control message from the camera ({"t":"hello"|"mode"|"stats"|"error", ...}), or null. */
export function parseControl(text) {
  try {
    const m = JSON.parse(text);
    return m && typeof m === 'object' && typeof m.t === 'string' ? m : null;
  } catch {
    return null;
  }
}

/** The header of one binary chunk, or null when it is not a CamOS JPEG chunk. */
export function parseChunk(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < HEADER_LENGTH) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== 0x43 || v.getUint8(1) !== 0x4a || v.getUint8(2) !== 1) return null;
  const headerLength = v.getUint8(3);
  if (headerLength < HEADER_LENGTH || headerLength > buffer.byteLength) return null;
  const seq = v.getUint32(4, true);
  const total = v.getUint32(8, true);
  const offset = v.getUint32(12, true);
  const ts = v.getUint32(16, true);
  const payload = new Uint8Array(buffer, headerLength);
  if (offset + payload.byteLength > total) return null;
  return { seq, total, offset, ts, payload };
}

/**
 * Puts JPEG frames back together from their chunks. push() returns a complete frame
 * ({ seq, ts, bytes: Uint8Array }) or null; `dropped` counts frames overtaken before they were complete.
 */
export class JpegAssembler {
  constructor({ maxBytes = 2 * 1024 * 1024 } = {}) {
    this.maxBytes = maxBytes;
    this.dropped = 0;
    this.lastSeq = 0;
    this.frame = null;
  }

  push(buffer) {
    const c = parseChunk(buffer);
    if (!c || c.total === 0 || c.total > this.maxBytes) return null;
    if (c.seq <= this.lastSeq) return null; // a frame already shown (or given up)
    if (!this.frame || c.seq > this.frame.seq) {
      if (this.frame) this.dropped++;
      this.frame = { seq: c.seq, ts: c.ts, total: c.total, bytes: new Uint8Array(c.total), got: 0, seen: new Set() };
    } else if (c.seq < this.frame.seq) {
      return null; // a late chunk of a frame already dropped
    }
    const f = this.frame;
    if (c.total !== f.total || f.seen.has(c.offset)) return null;
    f.seen.add(c.offset);
    f.bytes.set(c.payload, c.offset);
    f.got += c.payload.byteLength;
    if (f.got < f.total) return null;
    this.frame = null;
    this.lastSeq = f.seq;
    return { seq: f.seq, ts: f.ts, bytes: f.bytes };
  }

  reset() {
    this.frame = null;
    this.lastSeq = 0;
  }
}

/** Frames per second over the last few seconds of completed frames. */
export class RateMeter {
  constructor(windowMs = 3000) {
    this.windowMs = windowMs;
    this.times = [];
  }

  tick(now) {
    this.times.push(now);
    while (this.times.length && now - this.times[0] > this.windowMs) this.times.shift();
  }

  fps(now) {
    while (this.times.length && now - this.times[0] > this.windowMs) this.times.shift();
    if (this.times.length < 2) return 0;
    return Math.round(((this.times.length - 1) * 1000 / (this.times[this.times.length - 1] - this.times[0])) * 10) / 10;
  }
}

export function loadQualityChoice(storage = globalThis.localStorage) {
  try {
    const v = storage?.getItem(STORAGE_KEY);
    return QUALITY_CHOICES.includes(v) || JPEG_CHOICE.test(v || '') ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function saveQualityChoice(choice, storage = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, choice);
  } catch {
    // private window or blocked storage: the choice lasts for this page only
  }
}
