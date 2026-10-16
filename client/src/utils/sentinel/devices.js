// Device page helpers: shadow image values, telemetry series, capture budget.

const arr = (v) => (Array.isArray(v) ? v : [])

/** video.image block of a shadow document (reported or desired). Tolerates {state:{reported:...}} wrappers. */
export function shadowImage(doc) {
  if (!doc || typeof doc !== 'object') return null
  const d = doc.state?.reported || doc.state?.desired || doc
  const img = d?.video?.image
  return img && typeof img === 'object' ? img : null
}

/** Rows for the before/after table: every key that appears on either side, with a changed flag. */
export function diffSettings(before, after) {
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
  return keys.map((k) => ({
    key: k,
    before: before?.[k] ?? null,
    after: after?.[k] ?? null,
    changed: before?.[k] !== undefined && after?.[k] !== undefined ? before[k] !== after[k] : after?.[k] !== undefined,
  }))
}

/**
 * Telemetry series. The API gives the latest `telemetry` only; a history array (`telemetry_history`) is used when the
 * backend ships it, otherwise the page keeps a client-side rolling buffer of what it has polled.
 */
export function telemetryPoints(device, field = 'battery_percent') {
  const hist = arr(device?.telemetry_history)
  const pts = hist
    .map((h) => ({ at: h.at || h.ts, v: Number(h[field] ?? h.telemetry?.[field]) }))
    .filter((p) => p.at && Number.isFinite(p.v))
  return pts
}

export function latestTelemetry(device) {
  const t = device?.telemetry || {}
  return {
    battery: device?.battery_percent ?? t.battery_percent ?? t.battery ?? null,
    rssi: device?.rssi ?? t.rssi ?? null,
    temp: t.temp_c ?? t.temperature ?? null,
    at: device?.telemetry_at || null,
  }
}

/** agent_state.budgets: {"<name>": {used, limit}} or {"<name>_used": n, "<name>_limit": m}. */
export function budgetUsed(device) {
  const b = device?.agent_state?.budgets || device?.budgets || null
  if (!b || typeof b !== 'object') return null
  const used = b.captures_used ?? b.capture_used ?? b.extra_captures ?? b.used ?? b.captures?.used ?? null
  const limit = b.captures_limit ?? b.capture_limit ?? b.max_extra_captures ?? b.limit ?? b.captures?.limit ?? null
  if (used === null) return { raw: b, used: null, limit: limit ?? null, pct: null }
  return { raw: b, used, limit, pct: limit ? Math.min(100, Math.round((used / limit) * 100)) : null }
}

/** SVG polyline points for a sparkline in a w x h box. */
export function sparkPath(points, w = 120, h = 28, pad = 2) {
  if (!points.length) return ''
  const vs = points.map((p) => p.v)
  const lo = Math.min(...vs)
  const hi = Math.max(...vs)
  const span = hi - lo || 1
  const step = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0
  return points
    .map((p, i) => `${(pad + i * step).toFixed(1)},${(h - pad - ((p.v - lo) / span) * (h - pad * 2)).toFixed(1)}`)
    .join(' ')
}
