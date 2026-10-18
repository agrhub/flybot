import { describe, it, expect } from 'vitest';
import { changedSettings, effectiveValue } from '@/utils/camosSettingsForm';

const fields = [
  { path: 'capture.intervalMin', type: 'int', nullable: true },
  { path: 'capture.jpegQuality', type: 'int' },
  { path: 'motion.enabled', type: 'bool' },
  { path: 'capture.window', type: 'window', nullable: true },
  { path: 'motion.area', type: 'area' },
];

describe('effectiveValue', () => {
  it('prefers what FlyBot asked for, then what the camera reports', () => {
    expect(effectiveValue({ desired: 30, reported: 60 })).toBe(30);
    expect(effectiveValue({ desired: null, reported: 60 })).toBe(60);
    expect(effectiveValue({ desired: null, reported: null })).toBeNull();
    expect(effectiveValue(undefined)).toBeNull();
  });
});

describe('changedSettings', () => {
  const initial = { 'capture.intervalMin': 60, 'capture.jpegQuality': 85, 'motion.enabled': false, 'capture.window': null, 'motion.area': [0, 0, 100, 100] };

  it('sends only what changed', () => {
    const current = { ...initial, 'motion.enabled': true, 'capture.window': { from: '06:00', to: '18:00' } };
    expect(changedSettings(fields, initial, current)).toEqual({ 'motion.enabled': true, 'capture.window': { from: '06:00', to: '18:00' } });
    expect(changedSettings(fields, initial, { ...initial })).toEqual({});
  });

  it('sends null only for nullable fields', () => {
    const current = { ...initial, 'capture.intervalMin': null, 'capture.jpegQuality': null };
    expect(changedSettings(fields, initial, current)).toEqual({ 'capture.intervalMin': null });
  });

  it('compares arrays and objects by value', () => {
    expect(changedSettings(fields, initial, { ...initial, 'motion.area': [0, 0, 100, 100] })).toEqual({});
    expect(changedSettings(fields, initial, { ...initial, 'motion.area': [10, 0, 90, 100] })).toEqual({ 'motion.area': [10, 0, 90, 100] });
  });
});
