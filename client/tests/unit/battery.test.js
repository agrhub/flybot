import { describe, it, expect } from 'vitest';
import { signalBars } from '@/utils/battery';

describe('signalBars', () => {
  it('turns RSSI into 0-4 bars with Wi-Fi and 4G steps', () => {
    expect([-50, -60, -70, -80, -90].map((r) => signalBars('wifi', r))).toEqual([4, 3, 2, 1, 0]);
    expect([-71, -90, -100, -110, -120].map((r) => signalBars('4g', r))).toEqual([4, 3, 2, 1, 0]);
    expect(signalBars('wifi', null)).toBe(0);
  });
});
