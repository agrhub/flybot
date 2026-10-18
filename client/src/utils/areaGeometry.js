/**
 * The motion area [x, y, w, h] in whole percent of the picture (camos-esp32-trap motion.area), and how a drag
 * changes it (components/cameras/AreaSelector.vue). Pure, for tests.
 */
const MIN = 5; // smallest side in percent, so the box stays grabbable
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** A valid area: integers, inside 0..100, at least MIN wide and high. */
export function normalizeArea(a) {
  if (!Array.isArray(a) || a.length !== 4 || !a.every((n) => Number.isFinite(Number(n)))) return [0, 0, 100, 100];
  let [x, y, w, h] = a.map((n) => Math.round(Number(n)));
  w = clamp(w, MIN, 100);
  h = clamp(h, MIN, 100);
  x = clamp(x, 0, 100 - w);
  y = clamp(y, 0, 100 - h);
  return [x, y, w, h];
}

/**
 * The area after a drag from `start` to `now` (points in percent): 'draw' a new box between the two points,
 * 'move' the box, or resize from a corner 'nw' | 'ne' | 'sw' | 'se' (the opposite corner stays).
 */
export function applyDrag(kind, from, start, now) {
  const p = [clamp(now[0], 0, 100), clamp(now[1], 0, 100)];
  const [x, y, w, h] = from;
  if (kind === 'draw') {
    const x0 = Math.min(start[0], p[0]);
    const y0 = Math.min(start[1], p[1]);
    return normalizeArea([x0, y0, Math.abs(p[0] - start[0]), Math.abs(p[1] - start[1])]);
  }
  if (kind === 'move') {
    return normalizeArea([x + (p[0] - start[0]), y + (p[1] - start[1]), w, h]);
  }
  const right = x + w;
  const bottom = y + h;
  const left = kind.includes('w') ? Math.min(p[0], right - MIN) : x;
  const top = kind.includes('n') ? Math.min(p[1], bottom - MIN) : y;
  const r = kind.includes('e') ? Math.max(p[0], x + MIN) : right;
  const b = kind.includes('s') ? Math.max(p[1], y + MIN) : bottom;
  return normalizeArea([left, top, r - left, b - top]);
}
