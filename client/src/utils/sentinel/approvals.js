// Sentinel approval decisions through FlyBot's proxy. POST .../decide only queues the decision (202);
// the agent updates the approval a few seconds later, so the page polls GET approvals/{id} until
// `status` leaves "pending". FlyBot's server adds who decided (the signed-in person).

export class DecisionError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export const DECISIONS = ['approve', 'reject'];
const STATUS_FOR = { approve: 'approved', reject: 'rejected' };

/**
 * @param {object} p
 * @param {string} p.id approval_id
 * @param {'approve'|'reject'} p.decision
 * @param {(id:string, decision:string)=>Promise<object>} p.decide        POST wrapper (returns the body)
 * @param {(id:string)=>Promise<object>} p.fetchApproval                    GET wrapper, {approval} or the item
 * @param {boolean} p.canDecide  admin / manager (viewers never send)
 * @returns {Promise<{status:string, approval:object|null, timedOut:boolean}>}
 */
export async function submitDecision({
  id,
  decision,
  decide,
  fetchApproval,
  canDecide = false,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  intervalMs = 1500,
  maxPolls = 14,
}) {
  if (!canDecide) throw new DecisionError('READ_ONLY', 'Read-only');
  if (!DECISIONS.includes(decision)) throw new DecisionError('BAD_DECISION', `unknown decision ${decision}`);

  const queued = await decide(id, decision);
  if (queued && queued.queued === false) throw new DecisionError('NOT_QUEUED', 'The server did not queue the decision');

  for (let i = 0; i < maxPolls; i += 1) {
    await sleep(intervalMs);
    const res = await fetchApproval(id);
    const approval = res?.approval || res;
    if (approval && approval.status && approval.status !== 'pending') {
      return { status: approval.status, approval, timedOut: false };
    }
  }
  // Queued, but the worker has not applied it yet (a cold start can take ~20 s)
  return { status: 'queued', approval: null, timedOut: true, expected: STATUS_FOR[decision] };
}

/** What the proposal asks for, from Approval.payload (treatment | card_change). */
export function describeProposal(a) {
  const p = a?.payload || {};
  if (a?.kind === 'treatment') {
    return { title: p.action || 'treatment', date: p.date || null, reason: p.reason || '', rotateFrom: p.rotateFrom || null };
  }
  return {
    title: p.reason_code || p.action || 'card_change',
    date: p.date || null,
    reason: p.reason || (Array.isArray(p.reasons) ? p.reasons.join('; ') : ''),
    rotateFrom: null,
  };
}

/** Seconds left until expires_at (negative when past), null when unknown. */
export function secondsLeft(a, now = Date.now()) {
  const t = a?.expires_at_ms ?? (a?.expires_at ? Date.parse(a.expires_at) : NaN);
  return Number.isFinite(t) ? Math.round((t - now) / 1000) : null;
}

export function mergeByCreated(...lists) {
  const seen = new Map();
  for (const l of lists) for (const a of l || []) seen.set(a.approval_id, a);
  return [...seen.values()].sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
}

/** Element Plus tag type for an approval status. */
export const STATUS_TAG = { pending: 'warning', approved: 'success', rejected: 'danger', expired: 'info' };
