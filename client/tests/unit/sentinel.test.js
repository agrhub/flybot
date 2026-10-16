import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { createRouter, createMemoryHistory } from 'vue-router';
import fixture from './fixtures/sentinel.json';

// Component mounts (Element Plus, the sidebar's icons) are slow on a busy machine
vi.setConfig({ testTimeout: 30000 });

// FlyBot's proxy (/api/sentinel/ui/*), answered from a fixture built from the Sentinel mock data
const routes = {};
const answer = (path) => {
  const handler = routes[path] ?? routes[path.split('/')[0]];
  if (handler instanceof Error) return Promise.reject(handler);
  return Promise.resolve({ data: typeof handler === 'function' ? handler(path) : handler });
};
vi.mock('@/services/api', () => ({
  default: {
    sentinelGet: vi.fn((path) => answer(path)),
    sentinelDecide: vi.fn(async (id, decision) => ({ data: { queued: true, approval_id: id, decision, by: 'Lan <lan@example.test>' } })),
    sentinelEvidenceUrl: (key) => `/api/sentinel/ui/evidence?key=${encodeURIComponent(key)}`,
    getFarmMap: vi.fn(async () => ({ data: { plots: [] } })),
    getCameras: vi.fn(async () => ({ data: { cameras: [] } })),
  },
}));

// Confirm dialogs answer "yes"
vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ElMessageBox: { confirm: vi.fn(async () => 'confirm') }, ElNotification: vi.fn() };
});

const manager = { id: 'u1', email: 'lan@example.test', name: 'Lan', role: 'manager', sentinelEnabled: true, sentinelCanDecide: true };
const viewer = { id: 'u2', email: 'binh@example.test', name: 'Binh', role: 'user', sentinelEnabled: true, sentinelCanDecide: false };
localStorage.setItem('user', JSON.stringify(manager));

const { default: api } = await import('@/services/api');
const { default: i18n } = await import('@/i18n');
const { useAuth } = await import('@/composables/useAuth');
const { useTheme } = await import('@/utils/theme');
const { useSentinel, resetSentinelState, sentinelErrorKind } = await import('@/composables/useSentinel');
const { decisionType, summarizeTrace, collectImages } = await import('@/utils/sentinel/trace');
const { submitDecision, DecisionError } = await import('@/utils/sentinel/approvals');
const { default: TraceDetail } = await import('@/components/sentinel/TraceDetail.vue');
const { default: TraceTable } = await import('@/components/sentinel/TraceTable.vue');
const { default: ApprovalCard } = await import('@/components/sentinel/ApprovalCard.vue');
const { default: SentinelPage } = await import('@/pages/sentinel/index.vue');
const { default: AppSidebar } = await import('@/components/layout/AppSidebar.vue');

const Stub = { template: '<div class="stub-page" />' };
const makeRouter = () => createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/dashboard', component: Stub },
    {
      path: '/sentinel',
      component: SentinelPage,
      children: [
        { path: '', name: 'sentinel', component: Stub },
        { path: 'traces', name: 'sentinel-traces', component: Stub },
        { path: 'approvals', name: 'sentinel-approvals', component: Stub },
        { path: 'density', name: 'sentinel-density', component: Stub },
        { path: 'devices', name: 'sentinel-devices', component: Stub },
        { path: 'bench', name: 'sentinel-bench', component: Stub },
      ],
    },
  ],
});

const httpError = (status, data = {}) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
const [cardTrace, glareTrace] = fixture.full;
const pendingCard = fixture.approvals.find((a) => a.status === 'pending');

async function mountWith(component, { user = manager, props = {}, path = '/dashboard' } = {}) {
  i18n.global.locale.value = 'en';
  useAuth().setAuth(user);
  const router = makeRouter();
  await router.push(path);
  const wrapper = mount(component, { props, global: { plugins: [i18n, ElementPlus, router] }, attachTo: document.body });
  await flushPromises();
  return { wrapper, router };
}

beforeEach(() => {
  resetSentinelState();
  for (const key of Object.keys(routes)) delete routes[key];
  Object.assign(routes, {
    summary: fixture.summary,
    traces: (path) => {
      const id = decodeURIComponent(path.split('/')[1] || '');
      return id ? { trace: fixture.full.find((x) => x.event_id === id) } : { items: fixture.slim, next: null };
    },
    approvals: (path) => {
      const id = path.split('/')[1];
      return id ? { approval: { ...pendingCard, status: 'approved', decided_by: 'Lan <lan@example.test>', decided_at: new Date().toISOString() } } : { items: fixture.approvals };
    },
  });
  api.sentinelGet.mockClear();
  api.sentinelDecide.mockClear();
  document.body.innerHTML = '';
});

describe('Sentinel helpers', () => {
  it('names each trace by what the agent did', () => {
    expect(decisionType(cardTrace)).toBe('card_change');
    expect(decisionType(glareTrace)).toBe('isp_fix');
    const slimKill = fixture.slim.find((x) => x.event_id === '01MOCK96290901');
    expect(decisionType(slimKill)).toBe('kill_switch');
    const s = summarizeTrace(fixture.slim[0]);
    expect(s.approval).toMatchObject({ kind: 'card_change', status: 'pending' });
    expect(collectImages(cardTrace).length).toBeGreaterThan(0);
  });

  it('a decision is sent once and polled until the agent applies it; viewers never send', async () => {
    const decide = vi.fn(async () => ({ queued: true }));
    const states = ['pending', 'approved'];
    const fetchApproval = vi.fn(async () => ({ approval: { status: states.shift() } }));
    const res = await submitDecision({ id: 'a1', decision: 'approve', decide, fetchApproval, canDecide: true, sleep: async () => {} });
    expect(res).toMatchObject({ status: 'approved', timedOut: false });
    expect(decide).toHaveBeenCalledWith('a1', 'approve');
    expect(fetchApproval).toHaveBeenCalledTimes(2);

    await expect(submitDecision({ id: 'a1', decision: 'approve', decide, fetchApproval, canDecide: false })).rejects.toBeInstanceOf(DecisionError);
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('reads the proxy errors: disabled, forbidden, conflict', () => {
    expect(sentinelErrorKind(httpError(503, { success: false, code: 'SENTINEL_DISABLED' }))).toBe('disabled');
    expect(sentinelErrorKind(httpError(403, { code: 'FORBIDDEN' }))).toBe('forbidden');
    expect(sentinelErrorKind(httpError(409, { code: 'CONFLICT' }))).toBe('conflict');
    expect(sentinelErrorKind(new Error('offline'))).toBe('network');
  });
});

describe('Sentinel traces', () => {
  it('shows Perception → Decision → Action and the evidence through FlyBot', async () => {
    const { wrapper } = await mountWith(TraceDetail, { props: { trace: cardTrace } });
    const text = wrapper.text();
    expect(text).toContain('Perception (OpenCV)');
    expect(text).toContain('Decision');
    expect(text).toContain('What the agent did');
    expect(wrapper.find('[data-test="count-opencv"]').text()).not.toBe('');
    expect(wrapper.findAll('[data-test="decision-item"]').some((d) => d.text().includes('card.full'))).toBe(true);
    expect(wrapper.findAll('[data-test="tool-call"]').some((c) => c.text().includes('propose_card_change'))).toBe(true);
    expect(wrapper.find('[data-test="approval-box"]').text()).toContain('Waiting');
    // Every picture comes from /api/sentinel/ui/evidence, never a presigned S3 URL
    const html = wrapper.html();
    expect(html).toContain('/api/sentinel/ui/evidence?key=s3');
    expect(html).not.toContain('amazonaws');
  });

  it('lists traces like the detection history and opens one on click', async () => {
    const { wrapper } = await mountWith(TraceTable, { props: { items: fixture.slim } });
    const rows = wrapper.findAll('.el-table__body tr.el-table__row');
    expect(rows.length).toBe(fixture.slim.length);
    expect(wrapper.findAll('[data-test="type-pill"]').map((p) => p.text())).toContain('Card change proposal');

    await wrapper.findAll('[data-test="trace-open"]')[0].trigger('click');
    await flushPromises();
    expect(api.sentinelGet.mock.calls.map((c) => c[0])).toContain(`traces/${encodeURIComponent(fixture.slim[0].event_id)}`);
    expect(wrapper.find('[data-test="trace-detail"]').exists()).toBe(true);
  });
});

describe('Sentinel approvals', () => {
  it('a manager approves through the proxy and sees the result', async () => {
    const { wrapper } = await mountWith(ApprovalCard, { props: { approval: pendingCard, canDecide: true, intervalMs: 0 } });
    expect(wrapper.find('[data-test="approve"]').exists()).toBe(true);
    await wrapper.find('[data-test="approve"]').trigger('click');
    // Sent, then polled until the agent applied it
    await vi.waitFor(async () => {
      await flushPromises();
      expect(wrapper.emitted('decided')).toBeTruthy();
    });
    // No "by" from the browser: FlyBot's server adds the signed-in person
    expect(api.sentinelDecide).toHaveBeenCalledWith(pendingCard.approval_id, 'approve');
    expect(api.sentinelGet.mock.calls.map((c) => c[0])).toContain(`approvals/${pendingCard.approval_id}`);
    expect(wrapper.find('[data-test="message"]').text()).toContain('Done: Approved.');
    expect(wrapper.emitted('decided')).toBeTruthy();
  });

  it('viewers see the proposal read-only, without Approve / Reject', async () => {
    useAuth().setAuth(viewer);
    // The role helper decides: a viewer cannot
    expect(useSentinel().canDecide.value).toBe(false);
    const { wrapper } = await mountWith(ApprovalCard, { user: viewer, props: { approval: pendingCard, canDecide: useSentinel().canDecide.value } });
    expect(wrapper.find('[data-test="approve"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="reject"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="read-only"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="status-pill"]').text()).toBe('Waiting');
  });

  it('a 403 from the proxy is shown, and nothing is polled', async () => {
    api.sentinelDecide.mockRejectedValueOnce(httpError(403, { success: false, code: 'FORBIDDEN' }));
    const { wrapper } = await mountWith(ApprovalCard, { props: { approval: pendingCard, canDecide: true, intervalMs: 0 } });
    await wrapper.find('[data-test="reject"]').trigger('click');
    await vi.waitFor(async () => {
      await flushPromises();
      expect(wrapper.find('[data-test="message"]').text()).toContain('Only administrators');
    });
    expect(api.sentinelDecide).toHaveBeenCalledWith(pendingCard.approval_id, 'reject');
    expect(api.sentinelGet).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="message"]').text()).toContain('Only administrators and managers decide');
  });

  it('links a proposal to its confirm card in the assistant', async () => {
    const { wrapper } = await mountWith(ApprovalCard, { props: { approval: pendingCard, canDecide: true } });
    await wrapper.find('[data-test="open-assistant"]').trigger('click');
    const { assistantFocus, isAssistantOpen } = useTheme();
    expect(assistantFocus.value?.proposalId).toBe(pendingCard.flybot_proposal_id);
    expect(isAssistantOpen.value).toBe(true);
    assistantFocus.value = null;
    isAssistantOpen.value = false;
  });
});

describe('Sentinel on and off', () => {
  it('the menu shows Sentinel only when the server has it on', async () => {
    const off = await mountWith(AppSidebar, { user: { ...manager, sentinelEnabled: false } });
    expect(off.wrapper.find('[data-tour="nav-sentinel"]').exists()).toBe(false);
    off.wrapper.unmount();
    const on = await mountWith(AppSidebar, { user: manager });
    expect(on.wrapper.find('[data-tour="nav-sentinel"]').exists()).toBe(true);
  });

  it('shows the disabled state when the account has no Sentinel', async () => {
    const { wrapper } = await mountWith({ template: '<router-view />' }, { user: { ...manager, sentinelEnabled: false }, path: '/sentinel' });
    expect(wrapper.find('[data-test="sentinel-disabled"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="sentinel-tab-traces"]').exists()).toBe(false);
    expect(api.sentinelGet).not.toHaveBeenCalled();
  });

  it('turns itself off when the proxy answers 503 SENTINEL_DISABLED', async () => {
    routes.summary = httpError(503, { success: false, code: 'SENTINEL_DISABLED', message: 'The Sentinel console is not set up on this server.' });
    const { wrapper } = await mountWith({ template: '<router-view />' }, { path: '/sentinel' });
    await flushPromises();
    expect(api.sentinelGet).toHaveBeenCalledWith('summary', { hours: 24 });
    expect(useSentinel().enabled.value).toBe(false);
    expect(wrapper.find('[data-test="sentinel-disabled"]').exists()).toBe(true);
  });

  it('shows the tabs, the pending count and the kill switch when on', async () => {
    routes.summary = { ...fixture.summary, kill_switch: { global: true, cameras: [] } };
    const { wrapper } = await mountWith({ template: '<router-view />' }, { path: '/sentinel' });
    expect(wrapper.find('[data-test="sentinel-tab-approvals"]').text()).toContain(String(fixture.summary.proposals_pending));
    expect(wrapper.find('[data-test="kill-banner"]').exists()).toBe(true);
    i18n.global.locale.value = 'vi';
    await flushPromises();
    expect(wrapper.find('[data-test="sentinel-tab-approvals"]').text()).toContain('Phê duyệt');
  });
});
