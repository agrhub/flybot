// Bench files (bench/results/*.json, uploaded to s3://.../bench/) are written by T4.1 and are not in the repo yet.
// This normalizer accepts the shapes the plan describes (per arm: p50/p95, fps, CPU, RSS, $/1000 images, per-op)
// under a few key spellings, so the page works as soon as the first file lands, and shows the raw JSON otherwise.

const FIRST = (o, keys) => {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k]
  return null
}
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function armLabel(a) {
  return FIRST(a, ['label', 'arm', 'name', 'id', 'build']) || 'arm'
}

export function normalizeArm(a) {
  const ms = a.ms || a.latency_ms || a.latency || {}
  return {
    label: String(armLabel(a)),
    build: FIRST(a, ['build', 'opencv_build', 'package']),
    instance: FIRST(a, ['instance', 'instance_type', 'machine']),
    arch: FIRST(a, ['arch', 'architecture']),
    opencv: FIRST(a, ['opencv', 'opencv_version', 'cv2']),
    p50: num(FIRST(a, ['p50_ms', 'p50']) ?? ms.p50),
    p95: num(FIRST(a, ['p95_ms', 'p95']) ?? ms.p95),
    fps: num(FIRST(a, ['fps', 'throughput_fps'])),
    cpu: num(FIRST(a, ['cpu_pct', 'cpu_percent', 'cpu'])),
    rss: num(FIRST(a, ['rss_mb', 'rss'])),
    cost: num(FIRST(a, ['usd_per_1000', 'cost_per_1000', 'usd_per_1000_images'])),
    perOp: normalizePerOp(a.per_op || a.ops || null),
    n: num(FIRST(a, ['n_images', 'images', 'n'])),
    runs: num(FIRST(a, ['runs', 'repeats'])),
  }
}

function normalizePerOp(po) {
  if (!po || typeof po !== 'object') return []
  const entries = Array.isArray(po) ? po.map((x) => [x.op || x.name, x]) : Object.entries(po)
  return entries.map(([op, v]) => ({
    op,
    p50: num(typeof v === 'number' ? v : FIRST(v, ['p50_ms', 'p50'])),
    p95: num(typeof v === 'object' ? FIRST(v, ['p95_ms', 'p95']) : null),
  }))
}

/** -> {title, note, arms[], raw, empty}. `data` is one bench file. */
export function normalizeBench(data) {
  if (data === null || data === undefined) return { title: '', note: '', arms: [], raw: null, empty: true }
  let list = null
  if (Array.isArray(data)) list = data
  else list = data.arms || data.rows || data.results || data.runs || null
  if (!Array.isArray(list) && list && typeof list === 'object') {
    list = Object.entries(list).map(([k, v]) => ({ label: k, ...v }))
  }
  const arms = Array.isArray(list) ? list.filter((x) => x && typeof x === 'object').map(normalizeArm) : []
  return {
    title: (!Array.isArray(data) && (data.title || data.name || data.suite)) || '',
    note: (!Array.isArray(data) && (data.note || data.description)) || '',
    arms,
    raw: data,
    empty: arms.length === 0,
  }
}

/** Group arms by the three questions of the plan: COOL vs pip arm64 vs pip x86. */
export function armGroup(arm) {
  const s = `${arm.label} ${arm.build || ''} ${arm.arch || ''} ${arm.instance || ''}`.toLowerCase()
  if (/cool/.test(s)) return 'cool'
  if (/x86|c7i|amd64/.test(s)) return 'pip_x86'
  if (/arm64|aarch64|graviton|c7g|c8g/.test(s)) return 'pip_arm64'
  return 'other'
}
