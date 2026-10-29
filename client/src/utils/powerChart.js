/**
 * Helpers of the CamOS power charts (GET /api/cameras/:serial/power-history): the time axis ticks on local hour or
 * day boundaries, and the series of the voltage and rate charts as {x: ms, y} points.
 */

const HOUR_MS = 60 * 60 * 1000;

/** The ranges the chart offers, in days. */
export const POWER_RANGES = [1, 7, 30];

/**
 * Tick positions (ms) between `from` and `to`, on local boundaries: every 3 hours for a day, every day for a week,
 * every 5 days beyond.
 */
export function timeTicks(from, to, days) {
  const start = new Date(from);
  const ticks = [];
  if (days <= 1) {
    start.setMinutes(0, 0, 0);
    start.setHours(Math.ceil(start.getHours() / 3) * 3);
    for (let t = start; t <= to; t = new Date(t.getTime() + 3 * HOUR_MS)) if (t >= from) ticks.push(t.getTime());
    return ticks;
  }
  const step = days <= 7 ? 1 : 5;
  start.setHours(24, 0, 0, 0);
  for (let t = start; t <= to; t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + step)) ticks.push(t.getTime());
  return ticks;
}

/** The label of a tick: the hour for a day, the date beyond. */
export function tickLabel(ms, days, locale) {
  const d = new Date(ms);
  return days <= 1
    ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' });
}

const ms = (at) => new Date(at).getTime();
const volts = (mv) => (Number.isFinite(mv) ? Math.round(mv) / 1000 : null);

// Below this the panel gives nothing (night): a gap, so the volt axis stays on the cell's range
const NO_INPUT_MV = 500;

/**
 * The voltage chart's series from the answer's points: the cell (V), its percent, the panel / charger input (V) and
 * the raw reading while a charger lifts it (V). A series with no value at all is left empty.
 */
export function voltageSeries(points = []) {
  const series = { cell: [], pct: [], input: [], measured: [] };
  for (const p of points) {
    const x = ms(p.at);
    series.cell.push({ x, y: volts(p.mv) });
    if (Number.isFinite(p.pct)) series.pct.push({ x, y: p.pct });
    if (Number.isFinite(p.solarMv)) series.input.push({ x, y: p.solarMv >= NO_INPUT_MV ? volts(p.solarMv) : null });
    if (Number.isFinite(p.measuredMv)) series.measured.push({ x, y: volts(p.measuredMv) });
  }
  return series;
}

/** The rate chart's bars: mV/h at the middle of each interval, with its interval and %/h for the tooltip. */
export function rateSeries(rates = []) {
  return rates.map((r) => ({ x: ms(r.at), y: r.mvPerHour, pct: r.pctPerHour ?? null, from: ms(r.from), to: ms(r.to), charging: !!r.charging }));
}

/** The charging periods as [fromMs, toMs, slow] for the shaded bands. */
export function chargingBands(spans = []) {
  return spans.map((s) => [ms(s.from), ms(s.to), !!s.slow]);
}
