import { describe, it, expect } from 'vitest';
import { filterCameras, cameraState, nextWakeOf, markAwake } from '@/utils/cameraFilter';

const cams = [
  { deviceSerial: 'ESP0A1B2C3D4E5F', deviceName: 'Vĩnh Long', platform: 'camos', status: 1, model: 'AIC-FREENOVE-S3CAM' },
  { deviceSerial: 'BE4111159', deviceName: 'Bình Dương', platform: 'ezviz', status: 1, model: 'CS-EB8-R100' },
  { deviceSerial: 'BE4089629', deviceName: 'Củ Chi', platform: 'ezviz', status: 0 },
  { deviceSerial: 'AIC54F29F5167FA', deviceName: 'Đà Lạt', platform: 'kinesis', status: 0 },
];
const serials = (list) => list.map((c) => c.deviceSerial);

describe('filterCameras', () => {
  it('finds by name without accents, serial or model', () => {
    expect(serials(filterCameras(cams, { query: 'vinh long' }))).toEqual(['ESP0A1B2C3D4E5F']);
    expect(serials(filterCameras(cams, { query: 'da lat' }))).toEqual(['AIC54F29F5167FA']);
    expect(serials(filterCameras(cams, { query: '4089' }))).toEqual(['BE4089629']);
    expect(serials(filterCameras(cams, { query: 'freenove' }))).toEqual(['ESP0A1B2C3D4E5F']);
  });

  it('filters by online state and platform (kinesis counts as CamOS)', () => {
    expect(serials(filterCameras(cams, { status: 'online' }))).toEqual(['ESP0A1B2C3D4E5F', 'BE4111159']);
    expect(serials(filterCameras(cams, { status: 'offline', type: 'camos' }))).toEqual(['AIC54F29F5167FA']);
    expect(serials(filterCameras(cams, { type: 'ezviz' }))).toEqual(['BE4111159', 'BE4089629']);
    expect(filterCameras(cams)).toHaveLength(4);
    expect(filterCameras(null)).toEqual([]);
  });

  it('filters by trap kind (sticky by default) and by real or simulated', () => {
    const mixed = [
      { deviceSerial: 'REAL-LURE', trapKind: 'lure', status: 1 },
      { deviceSerial: 'REAL-STICKY', status: 1 },
      { deviceSerial: 'SIM-STICKY', trapKind: 'sticky', simulated: true, status: 1 },
    ];
    expect(serials(filterCameras(mixed, { kind: 'sticky' }))).toEqual(['REAL-STICKY', 'SIM-STICKY']);
    expect(serials(filterCameras(mixed, { kind: 'lure' }))).toEqual(['REAL-LURE']);
    expect(serials(filterCameras(mixed, { source: 'real' }))).toEqual(['REAL-LURE', 'REAL-STICKY']);
    expect(serials(filterCameras(mixed, { source: 'simulated', kind: 'sticky' }))).toEqual(['SIM-STICKY']);
  });
});

describe('cameraState', () => {
  const now = Date.parse('2026-10-26T08:00:00Z');
  it('says sleeping for a CamOS camera until its wake time, then offline', () => {
    const cam = { platform: 'camos', status: 0, device: { sleeping: true, wakeAt: '2026-10-26T08:30:00Z' } };
    expect(cameraState(cam, now)).toBe('sleeping');
    expect(cameraState(cam, Date.parse('2026-10-26T08:31:00Z'))).toBe('offline');
    expect(cameraState({ ...cam, device: { sleeping: true } }, now)).toBe('sleeping');
    expect(nextWakeOf(cam)).toBe('2026-10-26T08:30:00Z');
  });

  it('follows the status otherwise', () => {
    expect(cameraState({ platform: 'ezviz', status: 1 }, now)).toBe('online');
    expect(cameraState({ platform: 'ezviz', status: 0, device: { sleeping: true } }, now)).toBe('offline');
    expect(cameraState({ platform: 'kinesis', status: 0, device: { sleeping: false } }, now)).toBe('offline');
    expect(cameraState(null, now)).toBe('offline');
    expect(nextWakeOf({})).toBeNull();
  });
});

describe('markAwake', () => {
  it('turns a sleeping camera whose live view plays into an online one', () => {
    const now = Date.parse('2026-10-27T07:30:00Z');
    const cam = { platform: 'camos', status: 0, device: { sleeping: true, nextWakeAt: '2026-10-27T07:29:00Z' } };
    expect(cameraState(cam, now)).toBe('sleeping');
    markAwake(cam);
    expect(cameraState(cam, now)).toBe('online');
    expect(() => markAwake(null)).not.toThrow();
  });
});
