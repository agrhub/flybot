import { describe, it, expect } from 'vitest';
import {
  HEADER_LENGTH, JpegAssembler, RateMeter, QUALITY_PRESETS, ackMessage, loadQualityChoice, parseChunk, parseControl,
  presetFor, qualityMessage, saveQualityChoice,
} from '@/utils/camosLive';

// One binary message as the camera sends it: 'C' 'J' 1 20 | seq | total | offset | ts, then the bytes
function chunk(seq, total, offset, bytes, ts = 1000) {
  const buf = new ArrayBuffer(HEADER_LENGTH + bytes.length);
  const v = new DataView(buf);
  v.setUint8(0, 0x43); v.setUint8(1, 0x4a); v.setUint8(2, 1); v.setUint8(3, HEADER_LENGTH);
  v.setUint32(4, seq, true); v.setUint32(8, total, true); v.setUint32(12, offset, true); v.setUint32(16, ts, true);
  new Uint8Array(buf, HEADER_LENGTH).set(bytes);
  return buf;
}
const bytes = (n, fill) => new Uint8Array(n).fill(fill);

describe('parseChunk', () => {
  it('reads the header in little endian', () => {
    const c = parseChunk(chunk(7, 10, 4, bytes(6, 9), 123456));
    expect(c).toMatchObject({ seq: 7, total: 10, offset: 4, ts: 123456 });
    expect(Array.from(c.payload)).toEqual([9, 9, 9, 9, 9, 9]);
  });

  it('refuses what is not a CamOS chunk', () => {
    expect(parseChunk(new ArrayBuffer(4))).toBeNull();
    const bad = chunk(1, 4, 0, bytes(4, 1));
    new DataView(bad).setUint8(0, 0x58);
    expect(parseChunk(bad)).toBeNull();
    expect(parseChunk(chunk(1, 4, 2, bytes(4, 1)))).toBeNull(); // runs past the frame
    expect(parseChunk('text')).toBeNull();
  });
});

describe('JpegAssembler', () => {
  it('returns a frame once every chunk arrived, in any order', () => {
    const a = new JpegAssembler();
    expect(a.push(chunk(1, 6, 3, bytes(3, 2)))).toBeNull();
    const f = a.push(chunk(1, 6, 0, bytes(3, 1)));
    expect(f.seq).toBe(1);
    expect(Array.from(f.bytes)).toEqual([1, 1, 1, 2, 2, 2]);
  });

  it('drops a frame that a newer one overtakes, and ignores its late chunks', () => {
    const a = new JpegAssembler();
    a.push(chunk(1, 6, 0, bytes(3, 1)));
    expect(a.push(chunk(2, 2, 0, bytes(2, 5)))?.seq).toBe(2);
    expect(a.dropped).toBe(1);
    expect(a.push(chunk(1, 6, 3, bytes(3, 2)))).toBeNull();
  });

  it('ignores a repeated chunk and frames already shown', () => {
    const a = new JpegAssembler();
    a.push(chunk(3, 4, 0, bytes(2, 1)));
    expect(a.push(chunk(3, 4, 0, bytes(2, 1)))).toBeNull();
    expect(a.push(chunk(3, 4, 2, bytes(2, 2)))?.seq).toBe(3);
    expect(a.push(chunk(3, 2, 0, bytes(2, 1)))).toBeNull();
  });

  it('refuses frames over the size limit', () => {
    const a = new JpegAssembler({ maxBytes: 4 });
    expect(a.push(chunk(1, 8, 0, bytes(8, 1)))).toBeNull();
  });
});

describe('control messages', () => {
  it('asks for a preset and acknowledges frames', () => {
    expect(JSON.parse(qualityMessage(QUALITY_PRESETS.medium))).toEqual({ t: 'quality', mode: 'jpeg', w: 640, h: 480, q: 12, fps: 15 });
    expect(JSON.parse(qualityMessage(QUALITY_PRESETS.low))).toEqual({ t: 'quality', mode: 'h264', w: 320, h: 240, fps: 10 });
    expect(JSON.parse(ackMessage(42))).toEqual({ t: 'ack', seq: 42 });
  });

  it('parses the camera\'s messages', () => {
    expect(parseControl('{"t":"mode","mode":"jpeg","w":640,"h":480}')).toMatchObject({ t: 'mode', mode: 'jpeg' });
    expect(parseControl('nope')).toBeNull();
    expect(parseControl('{"x":1}')).toBeNull();
  });

  it('maps a choice to a preset only when the data channel is open', () => {
    expect(presetFor('auto', false)).toBeNull();
    expect(presetFor('auto', true)).toBe(QUALITY_PRESETS.medium);
    expect(presetFor('high', true)).toBe(QUALITY_PRESETS.high);
    expect(presetFor('low', true)).toBe(QUALITY_PRESETS.low);
    expect(presetFor('medium', true)).toBe(QUALITY_PRESETS.medium);
    expect(presetFor('high', true)).toBe(QUALITY_PRESETS.high);
  });
});

describe('quality choice storage', () => {
  it('remembers a choice and falls back to auto', () => {
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    expect(loadQualityChoice(storage)).toBe('auto');
    saveQualityChoice('medium', storage);
    expect(loadQualityChoice(storage)).toBe('medium');
    store.set('flybot.camosLiveQuality', 'ultra');
    expect(loadQualityChoice(storage)).toBe('auto');
  });

  it('survives a storage that throws', () => {
    const storage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadQualityChoice(storage)).toBe('auto');
    expect(() => saveQualityChoice('high', storage)).not.toThrow();
  });
});

describe('RateMeter', () => {
  it('counts frames per second over its window', () => {
    const r = new RateMeter(3000);
    for (let t = 0; t <= 2000; t += 100) r.tick(t);
    expect(r.fps(2000)).toBe(10);
    expect(r.fps(9000)).toBe(0);
  });
});
