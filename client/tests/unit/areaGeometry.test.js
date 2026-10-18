import { describe, it, expect } from 'vitest';
import { applyDrag, normalizeArea } from '@/utils/areaGeometry';

describe('normalizeArea', () => {
  it('keeps the box inside the picture, whole percent, at least 5 %', () => {
    expect(normalizeArea([10.4, 20.6, 50, 40])).toEqual([10, 21, 50, 40]);
    expect(normalizeArea([90, 90, 30, 30])).toEqual([70, 70, 30, 30]);
    expect(normalizeArea([0, 0, 1, 1])).toEqual([0, 0, 5, 5]);
    expect(normalizeArea(null)).toEqual([0, 0, 100, 100]);
  });
});

describe('applyDrag', () => {
  const from = [10, 10, 40, 30];
  it('draws a new box between the two points, in any direction', () => {
    expect(applyDrag('draw', from, [60, 70], [20, 30])).toEqual([20, 30, 40, 40]);
  });
  it('moves the box and stops it at the edges', () => {
    expect(applyDrag('move', from, [20, 20], [30, 25])).toEqual([20, 15, 40, 30]);
    expect(applyDrag('move', from, [20, 20], [120, 120])).toEqual([60, 70, 40, 30]);
  });
  it('resizes from a corner, the opposite corner stays', () => {
    expect(applyDrag('se', from, [50, 40], [70, 60])).toEqual([10, 10, 60, 50]);
    expect(applyDrag('nw', from, [10, 10], [0, 0])).toEqual([0, 0, 50, 40]);
    expect(applyDrag('nw', from, [10, 10], [80, 80])).toEqual([45, 35, 5, 5]);
  });
});
