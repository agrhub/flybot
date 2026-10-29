import { describe, it, expect } from 'vitest';
import { timeTicks, voltageSeries, rateSeries, chargingBands } from '@/utils/powerChart';

const HOUR = 60 * 60 * 1000;

describe('power chart helpers', () => {
  it('ticks every 3 local hours for a day, on local midnights for a week', () => {
    const from = new Date(2026, 9, 28, 10, 20);
    const day = timeTicks(from, new Date(from.getTime() + 24 * HOUR), 1);
    expect(day.length).toBe(8);
    expect(new Date(day[0]).getHours()).toBe(12);
    expect(day.every((t) => new Date(t).getMinutes() === 0 && new Date(t).getHours() % 3 === 0)).toBe(true);

    const week = timeTicks(from, new Date(from.getTime() + 7 * 24 * HOUR), 7);
    expect(week.length).toBe(7);
    expect(week.every((t) => new Date(t).getHours() === 0)).toBe(true);
    expect(timeTicks(from, new Date(from.getTime() + 30 * 24 * HOUR), 30).length).toBe(6);
  });

  it('builds the series in volts, leaving out what the camera did not send', () => {
    const s = voltageSeries([
      { at: '2026-10-29T00:00:00Z', mv: 3800, pct: 50 },
      { at: '2026-10-29T01:00:00Z', mv: 3730, pct: 45, solarMv: 3800, measuredMv: 3950, charging: true },
      { at: '2026-10-29T02:00:00Z', mv: 3720, solarMv: 0 },
    ]);
    expect(s.cell.map((p) => p.y)).toEqual([3.8, 3.73, 3.72]);
    expect(s.pct.map((p) => p.y)).toEqual([50, 45]);
    // No input at night is a gap, not 0 V
    expect(s.input).toEqual([{ x: Date.parse('2026-10-29T01:00:00Z'), y: 3.8 }, { x: Date.parse('2026-10-29T02:00:00Z'), y: null }]);
    expect(s.measured.map((p) => p.y)).toEqual([3.95]);
  });

  it('rates and charging bands keep their times', () => {
    const [r] = rateSeries([{ at: '2026-10-29T01:30:00Z', from: '2026-10-29T01:00:00Z', to: '2026-10-29T02:00:00Z', mvPerHour: -18, charging: false }]);
    expect(r).toEqual({ x: Date.parse('2026-10-29T01:30:00Z'), y: -18, pct: null, from: Date.parse('2026-10-29T01:00:00Z'), to: Date.parse('2026-10-29T02:00:00Z'), charging: false });
    expect(chargingBands([{ from: '2026-10-29T01:00:00Z', to: '2026-10-29T03:00:00Z', slow: true }])).toEqual([[Date.parse('2026-10-29T01:00:00Z'), Date.parse('2026-10-29T03:00:00Z'), true]]);
  });
});
