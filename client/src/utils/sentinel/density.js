// Density map helpers: marker positions and the heat overlay. The API returns the trap values and the hot-zone
// polygons (build_density_map); when it does not ship the interpolated cells, the overlay is rebuilt here with the
// same inverse-distance weighting (power 2) so the heat matches what the vision op computed.

const M_PER_DEG_LAT = 110574

export function metresPerDegLon(lat) {
  return 111320 * Math.cos((lat * Math.PI) / 180)
}

/** Grid bounds [[south, west], [north, east]] from build_density_map's grid (origin = NW corner, row 0 = north). */
export function gridBounds(grid) {
  if (!grid || !Array.isArray(grid.origin)) return null
  const [lon0, lat0] = grid.origin
  const wM = grid.width * grid.cell_m
  const hM = grid.height * grid.cell_m
  const north = lat0
  const south = lat0 - hM / M_PER_DEG_LAT
  const west = lon0
  const east = lon0 + wM / metresPerDegLon(lat0)
  return [
    [south, west],
    [north, east],
  ]
}

/**
 * Marker list: density traps carry lat/lon/value; devices may carry lat/lon too (UI_API does not promise it).
 * Devices win for name/kind, density wins for value. Anything without coordinates is returned in `unplaced`.
 */
export function mergeMarkers(devices = [], density = null) {
  const byId = new Map()
  for (const t of density?.traps || []) byId.set(String(t.id), { ...t })
  const placed = []
  const unplaced = []
  const used = new Set()
  for (const d of devices) {
    const lat = d.lat ?? d.latitude ?? d.location?.lat
    const lon = d.lon ?? d.lng ?? d.longitude ?? d.location?.lon ?? d.location?.lng
    const t = byId.get(String(d.serial)) || null
    if (t) used.add(String(t.id))
    const marker = {
      id: d.serial,
      name: d.name || d.serial,
      kind: d.trap_kind || null,
      source: d.source || null,
      bench: /bench/i.test(d.name || '') || d.role === 'bench',
      online: d.online ?? null,
      value: t?.value ?? null,
      lat: lat ?? t?.lat ?? null,
      lon: lon ?? t?.lon ?? null,
    }
    ;(marker.lat != null && marker.lon != null ? placed : unplaced).push(marker)
  }
  for (const t of byId.values()) {
    if (used.has(String(t.id))) continue
    if (t.lat != null && t.lon != null) {
      placed.push({ id: t.id, name: String(t.id), kind: null, source: null, bench: false, online: null, value: t.value ?? null, lat: t.lat, lon: t.lon })
    }
  }
  return { placed, unplaced }
}

/** Sequential colour ramp (light yellow -> orange -> dark red), colour-blind safe enough with the legend numbers. */
export const RAMP = [
  [255, 247, 188],
  [254, 196, 79],
  [236, 112, 20],
  [153, 52, 4],
  [102, 37, 6],
]

export function rampColor(t) {
  const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1)
  const i = Math.min(RAMP.length - 2, Math.floor(x))
  const f = x - i
  return RAMP[i].map((c, k) => Math.round(c + (RAMP[i + 1][k] - c) * f))
}

/** Interpolated values on the API grid (row-major, row 0 = north). Uses grid.values when the API ships them. */
export function gridValues(density, traps) {
  const g = density?.grid
  if (!g) return null
  if (Array.isArray(g.values) && g.values.length === g.width * g.height) return Float32Array.from(g.values)
  const pts = (traps || []).filter((t) => t.lat != null && t.lon != null && Number.isFinite(t.value))
  if (!pts.length) return null
  const [lon0, lat0] = g.origin
  const mLon = metresPerDegLon(lat0)
  const xy = pts.map((p) => [(p.lon - lon0) * mLon, (lat0 - p.lat) * M_PER_DEG_LAT]) // x east, y south from NW
  const maxD = g.max_dist_m || Infinity
  const out = new Float32Array(g.width * g.height).fill(NaN)
  for (let r = 0; r < g.height; r += 1) {
    for (let c = 0; c < g.width; c += 1) {
      const x = (c + 0.5) * g.cell_m
      const y = (r + 0.5) * g.cell_m
      let wsum = 0
      let vsum = 0
      let near = Infinity
      for (let i = 0; i < xy.length; i += 1) {
        const d2 = (xy[i][0] - x) ** 2 + (xy[i][1] - y) ** 2
        near = Math.min(near, d2)
        const w = 1 / Math.max(d2, 1e-6)
        wsum += w
        vsum += w * pts[i].value
      }
      if (Math.sqrt(near) <= maxD) out[r * g.width + c] = vsum / wsum
    }
  }
  return out
}

/** RGBA pixels for the overlay canvas (alpha 0 where the cell is unknown). */
export function heatPixels(values, g, [vmin, vmax], alpha = 170) {
  const px = new Uint8ClampedArray(g.width * g.height * 4)
  const span = Math.max(1e-9, vmax - vmin)
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i]
    if (Number.isNaN(v)) continue
    const [r, gg, b] = rampColor((v - vmin) / span)
    px[i * 4] = r
    px[i * 4 + 1] = gg
    px[i * 4 + 2] = b
    px[i * 4 + 3] = alpha
  }
  return px
}

/** Data URL of the heat overlay; null when no canvas is available (unit tests, SSR). */
export function heatDataUrl(density, traps) {
  if (typeof document === 'undefined') return null
  const g = density?.grid
  const values = gridValues(density, traps)
  if (!g || !values) return null
  const canvas = document.createElement('canvas')
  canvas.width = g.width
  canvas.height = g.height
  const ctx = canvas.getContext?.('2d')
  if (!ctx) return null
  const range = density.value_range || [Math.min(...values.filter(Number.isFinite)), Math.max(...values.filter(Number.isFinite))]
  const img = new ImageData(heatPixels(values, g, range), g.width, g.height)
  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL('image/png')
}

/** The daily job's file holds both `map` (build_density_map) and `traps` (id, lat, lon, value). */
export function normalizeDensity(res) {
  if (!res) return null
  const map = res.map || {}
  const traps = (res.traps || []).map((t) => ({ ...t }))
  return {
    date: res.date,
    status: res.status || 'ok',
    generatedAt: res.generated_at || null,
    synthetic: !!(res.synthetic ?? map.synthetic ?? /synthetic/i.test(String(res.source || res.note || ''))),
    note: res.note || null,
    grid: map.grid || res.grid || null,
    valueRange: map.value_range || res.value_range || null,
    hotThreshold: map.hot_threshold ?? res.hot_threshold ?? null,
    hotZones: map.hot_zones || res.hot_zones || null,
    traps,
    png: res.png || map.evidence?.png || null,
    label: map.hot_zones?.properties?.label || 'flies/trap/day',
  }
}
