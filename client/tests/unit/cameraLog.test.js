import { describe, it, expect } from 'vitest';
import { mergeLogLines } from '@/utils/cameraLog';

const line = (s, msg, tag = 'proto', lvl = 3) => ({ at: `2026-10-19T14:00:${String(s).padStart(2, '0')}Z`, msg, tag, lvl });

describe('camera log lines', () => {
  it('drops lines it already has and keeps time order', () => {
    const a = mergeLogLines([], [line(1, 'one'), line(2, 'two')]);
    const b = mergeLogLines(a, [line(2, 'two'), line(3, 'three')]);
    expect(b.map(l => l.msg)).toEqual(['one', 'two', 'three']);
    const c = mergeLogLines(b, [line(0, 'zero')]);
    expect(c.map(l => l.msg)).toEqual(['zero', 'one', 'two', 'three']);
    expect(mergeLogLines(c, [])).toBe(c);
  });

  it('keeps the newest lines only', () => {
    const many = Array.from({ length: 10 }, (_, i) => line(i, `m${i}`));
    expect(mergeLogLines([], many, 4).map(l => l.msg)).toEqual(['m6', 'm7', 'm8', 'm9']);
  });

  it('ignores lines without text', () => {
    expect(mergeLogLines([], [null, { at: 1 }, line(1, 'ok')]).length).toBe(1);
  });
});
