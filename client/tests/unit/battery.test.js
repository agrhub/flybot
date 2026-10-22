import { describe, it, expect } from 'vitest';
import { batteryTagText } from '@/utils/battery';

const t = (key) => ({ 'cameras.battery.charging': 'Charging', 'cameras.battery.notCharging': 'Not charging' })[key];

describe('batteryTagText', () => {
  it('shows the level and whether the camera charges', () => {
    expect(batteryTagText({ pct: 53, charging: true }, t)).toBe('53 % · Charging');
    expect(batteryTagText({ pct: 53, charging: false }, t)).toBe('53 % · Not charging');
  });

  it('shows the level alone when the camera does not say', () => {
    expect(batteryTagText({ pct: 0, mv: 3300 }, t)).toBe('0 %');
  });

  it('is empty without a level', () => {
    expect(batteryTagText(null, t)).toBe('');
    expect(batteryTagText({ charging: true }, t)).toBe('');
  });
});
