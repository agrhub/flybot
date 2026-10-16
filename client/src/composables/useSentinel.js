import { reactive, computed } from 'vue';
import api from '@/services/api';
import { useAuth } from '@/composables/useAuth';

/**
 * FlyBot Sentinel console: whether it is on for this person, whether they may decide, and the
 * shared summary (kill switch, pending proposals) the Sentinel pages show.
 *
 * The server tells: /api/auth/me carries sentinelEnabled (configured + allowed to read) and
 * sentinelCanDecide (admin / manager). Any Sentinel call answering 503 SENTINEL_DISABLED turns the
 * console off for this session. VITE_SENTINEL_MOCK=1 (dev server against the Sentinel mock, see
 * vite.config.js) turns it on without a configured server.
 */
const MOCK = !!import.meta.env.VITE_SENTINEL_MOCK;

const state = reactive({
  disabled: false, // a call said SENTINEL_DISABLED
  summary: null,
  summaryError: null,
  loadedAt: null,
  loading: false,
});

/** 'disabled' | 'forbidden' | 'notFound' | 'conflict' | 'unavailable' | 'network' | 'error' */
export function sentinelErrorKind(err) {
  const status = err?.response?.status;
  const code = err?.response?.data?.code || err?.response?.data?.error?.code;
  if (code === 'SENTINEL_DISABLED') return 'disabled';
  if (!err?.response) return 'network';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'notFound';
  if (status === 409) return 'conflict';
  if (status === 502 || status === 503 || status === 504) return 'unavailable';
  return 'error';
}

/** Remember a disabled answer; returns the error kind. */
export function noteSentinelError(err) {
  const kind = sentinelErrorKind(err);
  if (kind === 'disabled') state.disabled = true;
  return kind;
}

/** GET a Sentinel UI route through FlyBot's proxy and return the body. */
export async function sentinelGet(path, params = {}) {
  try {
    const res = await api.sentinelGet(path, params);
    return res.data;
  } catch (err) {
    noteSentinelError(err);
    throw err;
  }
}

export const items = (res) => (Array.isArray(res) ? res : res?.items || []);

export function useSentinel() {
  const { user, canManageCameras } = useAuth();

  const enabled = computed(() => {
    if (state.disabled) return false;
    if (MOCK) return true;
    return user.value?.sentinelEnabled === true;
  });
  // Approve / Reject: admins and managers (the server checks again; viewers get 403). A judge
  // token upstream (summary.role) is read-only as well.
  const canDecide = computed(() => enabled.value
    && canManageCameras.value
    && (MOCK || user.value?.sentinelCanDecide !== false)
    && state.summary?.role !== 'judge');

  const refreshSummary = async (hours = 24) => {
    if (!enabled.value) return null;
    state.loading = true;
    try {
      state.summary = await sentinelGet('summary', { hours });
      state.summaryError = null;
      state.loadedAt = Date.now();
    } catch (err) {
      state.summaryError = sentinelErrorKind(err);
    } finally {
      state.loading = false;
    }
    return state.summary;
  };

  return {
    state,
    enabled,
    canDecide,
    refreshSummary,
  };
}

// Tests start from a clean state
export function resetSentinelState() {
  Object.assign(state, { disabled: false, summary: null, summaryError: null, loadedAt: null, loading: false });
}

export default useSentinel;
