// Pure helpers that turn the agent's Trace (sentinel.common.schemas.Trace) or the slim list item of
// GET /ui/traces into what the Traces page renders. No Vue here, so they are unit-tested directly.

export const DECISION_TYPES = [
  'treatment',
  'card_change',
  'human_review',
  'isp_fix',
  'recapture',
  'followup',
  'kill_switch',
  'no_op',
]

// tool name -> decision type; the first match in this priority order names the trace.
const TOOL_TYPE = [
  ['propose_treatment', 'treatment'],
  ['propose_card_change', 'card_change'],
  ['request_human_review', 'human_review'],
  ['set_image', 'isp_fix'],
  ['set_detection_roi', 'isp_fix'],
  ['set_capture_schedule', 'isp_fix'],
  ['capture', 'recapture'],
  ['schedule_followup', 'followup'],
]

// Decision.action (what the slim list item carries) -> decision type
const ACTION_TYPE = {
  propose_treatment: 'treatment',
  treatment_check: 'treatment',
  propose_card_change: 'card_change',
  request_human_review: 'human_review',
  set_isp: 'isp_fix',
  set_image: 'isp_fix',
  capture: 'recapture',
  recapture: 'recapture',
  schedule_followup: 'followup',
  no_op: 'no_op',
}

const arr = (v) => (Array.isArray(v) ? v : [])

/** Everything a trace did that changed the world or asked a human, as one filterable label. */
export function decisionType(trace) {
  if (!trace) return 'no_op'
  const tools = arr(trace.tool_calls).filter((c) => c.status === 'ok' && c.by !== 'guardrail')
  for (const [tool, type] of TOOL_TYPE) {
    if (tools.some((c) => c.name === tool)) return type
  }
  const outcome = String(trace.outcome || '')
  if (trace.kill_switch || outcome.startsWith('kill_switch')) return 'kill_switch'
  // slim list items carry decisions[{rule, action}] but no tool calls
  for (const d of [...arr(trace.decisions)].reverse()) {
    const t = ACTION_TYPE[d.action]
    if (t && t !== 'no_op') return t
  }
  if (outcome.includes('treatment')) return 'treatment'
  return 'no_op'
}

/** The observation of the camera the trace is about (opencv_outputs is keyed camera or camera/image). */
export function primaryObservation(trace) {
  const outs = trace?.opencv_outputs
  if (!outs || typeof outs !== 'object') return null
  const entries = Object.entries(outs)
  if (!entries.length) return null
  const byId = entries.find(([, o]) => o && o.event_id === trace.event_id)
  const byCam = entries.find(([k, o]) => k === trace.camera || (o && o.camera === trace.camera))
  const hit = byId || byCam || entries[0]
  return hit[1]
}

/** Observations of other cameras (neighbour captures). */
export function otherObservations(trace) {
  const outs = trace?.opencv_outputs
  if (!outs || typeof outs !== 'object') return []
  const main = primaryObservation(trace)
  return Object.entries(outs)
    .filter(([, o]) => o && o !== main)
    .map(([key, o]) => ({ key, ...o }))
}

const SCORE_LABELS = ['glare_ratio', 'clip_high', 'brightness', 'sharpness', 'contrast']

/** max - min over the non-null counts of the three sources (OpenCV, NPU, production). */
export function countSpread(counts) {
  const v = ['opencv', 'npu', 'production'].map((k) => counts?.[k]).filter((x) => typeof x === 'number')
  return v.length > 1 ? Math.max(...v) - Math.min(...v) : null
}

export function perceptionFacts(obs) {
  if (!obs) return null
  const nc = obs.new_catch || null
  return {
    camera: obs.camera,
    counts: { opencv: obs.counts?.opencv ?? null, npu: obs.counts?.npu ?? null, production: obs.counts?.production ?? null },
    spread: countSpread(obs.counts),
    quality: {
      ok: obs.quality?.ok !== false,
      issues: arr(obs.quality?.issues),
      score: obs.quality?.score ?? null,
      scores: SCORE_LABELS.filter((k) => obs.quality?.scores && k in obs.quality.scores).map((k) => [k, obs.quality.scores[k]]),
    },
    saturationPct: typeof obs.saturation === 'number' ? Math.round(obs.saturation * 1000) / 10 : null,
    registration: nc
      ? { ok: nc.registration_ok ?? null, inliers: nc.inliers ?? nc.registration_inliers ?? null }
      : null,
    newCatch: nc
      ? {
          new: nc.new_count ?? null,
          persisted: nc.persisted_count ?? null,
          disappeared: nc.disappeared_count ?? null,
          cardChange: !!nc.card_change_suspected,
          reasons: arr(nc.card_change_reasons),
        }
      : null,
    batteryPercent: obs.battery_percent ?? null,
    analyzer: obs.analyzer || null,
    visionMs: obs.vision_ms ?? null,
    evidence: arr(obs.evidence),
    image: obs.image || null,
    previousImage: obs.previous_image || null,
    untrusted: obs.untrusted_text && Object.keys(obs.untrusted_text).length ? obs.untrusted_text : null,
  }
}

export function plannerBadge(trace) {
  const p = trace?.planner
  if (!p) return { name: 'rule', fallback: false, detail: '' }
  if (typeof p === 'string') return { name: p, fallback: !!trace.fallback, detail: '' }
  return {
    name: p.name || 'rule',
    fallback: !!p.fallback,
    detail: [p.backend, p.model].filter(Boolean).join(' / '),
    reason: p.fallback_reason || null,
    turns: p.llm_turns || 0,
  }
}

/** One-line digest used in the collapsed timeline row. Works for slim list items and full traces. */
export function summarizeTrace(trace) {
  const obs = primaryObservation(trace)
  const counts = trace.counts || obs?.counts || {}
  const quality = trace.quality || obs?.quality || {}
  const approval = trace.approval || null
  const tools = arr(trace.tool_calls)
  return {
    eventId: trace.event_id,
    camera: trace.camera,
    source: trace.source || null,
    trapKind: trace.trap_kind || null,
    // Simulated demo data: the flies drawn on the photo, beside the detector's count
    ...(trace.simulated ? { simulated: true, simulatedTruth: trace.simulated_truth ?? null } : {}),
    createdAt: trace.created_at,
    state: trace.state,
    outcome: trace.outcome,
    type: decisionType(trace),
    planner: plannerBadge(trace),
    counts: { opencv: counts.opencv ?? null, npu: counts.npu ?? null, production: counts.production ?? null },
    issues: arr(quality.issues),
    approval: approval ? { id: approval.approval_id, kind: approval.kind, status: approval.status } : null,
    toolNames: tools.map((c) => c.name),
    blocked: tools.filter((c) => c.status === 'blocked').length,
    killSwitch: !!trace.kill_switch,
    isFull: Array.isArray(trace.tool_calls),
  }
}

/** Date (YYYY-MM-DD, local time) of a trace, used by the date filter. */
export function localDay(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function filterTraces(items, { camera = '', type = '', date = '' } = {}) {
  return items.filter((t) => {
    if (camera && t.camera !== camera) return false
    if (type && decisionType(t) !== type) return false
    if (date && localDay(t.created_at) !== date) return false
    return true
  })
}

/** Evidence kind from the file name: aligned pair halves, masks, crops, heatmaps, matches. */
export function evidenceKind(ref) {
  const name = String(ref || '').split('?')[0].toLowerCase()
  const base = name.split('/').pop() || ''
  if (/_aligned\./.test(base) || /_pair\./.test(base)) return 'aligned'
  if (/_heatmap\./.test(base) || /_diff\./.test(base)) return 'heatmap'
  if (/_matches\./.test(base)) return 'matches'
  if (/_mask\./.test(base) || /_blobs\./.test(base) || /_overlay\./.test(base)) return 'mask'
  if (/_crop\d*\./.test(base) || /_warped\./.test(base) || /_card\./.test(base)) return 'crop'
  if (/_quality\./.test(base)) return 'quality'
  if (/\.(jpe?g|png|webp)$/.test(base)) return 'photo'
  return null
}

const IMG_RE = /\.(jpe?g|png|webp)(\?|$)/i

/** Image refs in the trace (evidence refs, observation images, tool results); non-image refs (tool:3, ddb://, history://) are dropped. */
export function collectImages(trace) {
  const seen = new Map()
  const add = (ref, from) => {
    if (typeof ref !== 'string' || !IMG_RE.test(ref)) return
    if (!seen.has(ref)) seen.set(ref, { ref, kind: evidenceKind(ref), from })
  }
  for (const [key, o] of Object.entries(trace?.opencv_outputs || {})) {
    add(o?.image, o?.camera || key)
    add(o?.previous_image, o?.camera || key)
    for (const e of arr(o?.evidence)) add(e, o?.camera || key)
  }
  for (const d of arr(trace?.decisions)) for (const e of arr(d.evidence)) add(e, 'decision')
  for (const c of arr(trace?.tool_calls)) {
    for (const e of arr(c.result?.evidence)) add(e, c.name)
    add(c.result?.image, c.name)
    add(c.result?.before_image, c.name)
    add(c.result?.after_image, c.name)
  }
  for (const a of arr(trace?.device_ack)) for (const e of arr(a.evidence)) add(e, a.method)
  for (const e of arr(trace?.approval?.evidence)) add(e, 'approval')
  return [...seen.values()]
}

/**
 * Side-by-side view. The vision op writes the aligned pair as one composite picture (previous aligned | current | blend),
 * so that is shown as is; when only the two raw photos exist they are placed next to each other.
 */
export function alignedPair(images, obs) {
  const aligned = images.find((i) => i.kind === 'aligned')
  if (aligned) return { composite: aligned, left: null, right: null }
  const prev = obs?.previous_image ? images.find((i) => i.ref === obs.previous_image) : null
  const current = obs?.image ? images.find((i) => i.ref === obs.image) : null
  if (prev && current) return { composite: null, left: prev, right: current }
  return null
}

export function toolSummary(call) {
  const a = call.args || {}
  return Object.keys(a)
    .filter((k) => k !== 'reason')
    .map((k) => `${k}=${typeof a[k] === 'object' ? JSON.stringify(a[k]) : a[k]}`)
    .join(', ')
}

/** ISP changes (set_image) with the values before and after, for the Devices page and the trace view. */
export function ispChanges(trace) {
  return arr(trace?.tool_calls)
    .filter((c) => c.name === 'set_image' && c.status === 'ok')
    .map((c) => ({
      at: c.started_at,
      camera: c.args?.camera,
      before: c.result?.before_settings || {},
      after: c.result?.applied_settings || {},
      applied: c.result?.applied ?? null,
      reason: c.result?.reason || c.args?.reason || '',
      by: c.by,
    }))
}

/** Verification/revert events written by the guardrails after an ISP change. */
export function ispVerdict(trace) {
  const e = arr(trace?.events).find((x) => x.kind === 'isp_verified' || x.kind === 'isp_reverted')
  return e ? e.kind : null
}
