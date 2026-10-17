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

/** Quality choices of the live tab. `auto` takes JPEG medium (640x480, the steadiest on the board) when the data channel works, else H.264. */
export const QUALITY_PRESETS = {
  low: { mode: 'h264', w: 320, h: 240, fps: 10 },
  medium: { mode: 'jpeg', w: 640, h: 480, q: 12, fps: 15 },
  high: { mode: 'jpeg', w: 1024, h: 768, q: 12, fps: 10 },
};
export const QUALITY_CHOICES = ['auto', 'low', 'medium', 'high'];
const STORAGE_KEY = 'flybot.camosLiveQuality';

/** The preset a choice asks the camera for (auto: medium), or null for plain H.264 without a data channel. */
export function presetFor(choice, channelOpen) {
  if (!channelOpen) return null;
  if (choice === 'low') return QUALITY_PRESETS.low;
  if (choice === 'high') return QUALITY_PRESETS.high;
  return QUALITY_PRESETS.medium; // auto and medium
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
    return QUALITY_CHOICES.includes(v) ? v : 'auto';
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
