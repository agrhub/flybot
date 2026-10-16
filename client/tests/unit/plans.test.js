import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { createRouter, createMemoryHistory } from 'vue-router';

vi.setConfig({ testTimeout: 30000 });

const calls = { createUpgradeRequest: [] };
let plansAnswer = { appMode: 'hybrid', pricing: true, plans: [] };
vi.mock('@/services/api', () => ({
  default: {
    getPlans: vi.fn(async () => ({ data: plansAnswer })),
    getEntitlements: vi.fn(async () => ({ data: {
      workspace: { id: 'w1', name: 'Lan', kind: 'personal', role: 'owner', plan: 'free' },
      entitlements: { plan: 'free', planName: 'FREE', exempt: false, expired: false, maxCameras: 3, snapshotsPerDay: 48, retentionDays: 30, deepAnalysisPerMonth: 20, liveMinutes: 5, maxMembers: 1, features: { telegram: true, pdfReports: false, apiAndWebhooks: false } },
      usage: { cameras: 2, members: 1, deepAnalyses: 5 },
    } })),
    getUpgradeRequests: vi.fn(async () => ({ data: { requests: [] } })),
    createUpgradeRequest: vi.fn(async (body) => {
      calls.createUpgradeRequest.push(body);
      return { data: { request: { id: 'r1', status: 'pending' } } };
    }),
    getWorkspaces: vi.fn(async () => ({ data: { workspaces: [{ id: 'w1', name: 'Lan', kind: 'personal', plan: 'free' }, { id: 'w2', name: 'HTX', kind: 'organization', plan: 'enterprise' }] } })),
    setCurrentWorkspace: vi.fn(async () => ({ data: { success: true } })),
    getMe: vi.fn(async () => ({ data: {} })),
  },
}));

const plan = (code, extra = {}) => ({ code, name: code.toUpperCase(), maxCameras: 3, snapshotsPerDay: 48, retentionDays: 30, deepAnalysisPerMonth: 20, liveMinutesPerRequest: 5, maxMembers: 1, features: { telegram: true, pdfReports: false, apiAndWebhooks: false }, priceNote: '', visible: true, order: 1, ...extra });

const { default: i18n } = await import('@/i18n');
const { useAuth } = await import('@/composables/useAuth');
const { useUpgrade, openUpgradeDialog } = await import('@/composables/useUpgrade');
const { default: UsageCard } = await import('@/components/plans/UsageCard.vue');
const { default: UpgradeDialog } = await import('@/components/plans/UpgradeDialog.vue');
const { default: WorkspaceSwitcher } = await import('@/components/plans/WorkspaceSwitcher.vue');
const { default: PricingPage } = await import('@/pages/pricing/index.vue');

const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/pricing', name: 'pricing', component: { template: '<div />' } }] });
const mountIt = (component) => mount(component, { global: { plugins: [ElementPlus, i18n, router] }, attachTo: document.body });

const signIn = (extra = {}) => useAuth().setAuth({ id: 'u1', email: 'lan@example.test', role: 'user', appMode: 'hybrid', workspace: { id: 'w1', name: 'Lan', kind: 'personal', role: 'owner', plan: 'free' }, workspaceCount: 1, plan: { code: 'free', name: 'FREE' }, capabilities: { addCameras: true, pricing: true, upgradeRequests: true, requestOrganization: true }, ...extra });

describe('plans and workspaces', () => {
  beforeEach(() => {
    calls.createUpgradeRequest.length = 0;
    useUpgrade().state.open = false;
    document.body.innerHTML = '';
  });

  it('capabilities come from the server, not the role', () => {
    signIn({ role: 'user', capabilities: { addCameras: true, buildDashboards: true } });
    expect(useAuth().canManageCameras.value).toBe(true);
    signIn({ role: 'manager', capabilities: { addCameras: false, buildDashboards: false } });
    expect(useAuth().canManageCameras.value).toBe(false);
  });

  it('usage card: "2 / 3" cameras and "5 / 20" deep analyses', async () => {
    signIn();
    const wrapper = mountIt(UsageCard);
    await flushPromises();
    expect(wrapper.find('[data-test="usage-plan"]').text()).toBe('FREE');
    expect(wrapper.find('[data-test="usage-cameras"]').text()).toBe('2 / 3');
    expect(wrapper.find('[data-test="usage-deep"]').text()).toBe('5 / 20');
    wrapper.unmount();
  });

  it('a plan limit opens the upgrade dialog, which sends the request', async () => {
    signIn();
    const wrapper = mountIt(UpgradeDialog);
    openUpgradeDialog({ code: 'UPGRADE_REQUIRED', limit: 'cameras', used: 3, max: 3, plan: 'free' });
    await flushPromises();
    expect(document.body.textContent).toContain(i18n.global.t('upgrade.limits.cameras', { used: 3, max: 3 }));
    document.querySelector('[data-test="upgrade-submit"]').click();
    await flushPromises();
    expect(calls.createUpgradeRequest).toEqual([expect.objectContaining({ type: 'plan', targetPlan: 'pro', reason: 'cameras' })]);
    expect(document.querySelector('[data-test="upgrade-sent"]')).not.toBeNull();
    wrapper.unmount();
  });

  it('organization request (hybrid) asks for the organization name', async () => {
    signIn();
    const wrapper = mountIt(UpgradeDialog);
    openUpgradeDialog({ type: 'organization' });
    await flushPromises();
    const input = document.querySelector('[data-test="org-name"] input') || document.querySelector('input[data-test="org-name"]');
    input.value = 'HTX Cái Bè';
    input.dispatchEvent(new Event('input'));
    await flushPromises();
    document.querySelector('[data-test="upgrade-submit"]').click();
    await flushPromises();
    expect(calls.createUpgradeRequest[0]).toEqual(expect.objectContaining({ type: 'organization', organization: expect.objectContaining({ name: 'HTX Cái Bè' }) }));
    wrapper.unmount();
  });

  it('pricing: plan cards, the organization card only in hybrid', async () => {
    signIn();
    plansAnswer = { appMode: 'hybrid', pricing: true, plans: [plan('free'), plan('pro', { maxCameras: 10 }), plan('enterprise', { maxCameras: 0 })] };
    let wrapper = mountIt(PricingPage);
    await flushPromises();
    expect(wrapper.find('[data-test="plan-free"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="plan-ask-free"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="plan-ask-pro"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="plan-organization"]').exists()).toBe(true);
    wrapper.unmount();

    plansAnswer = { appMode: 'b2c', pricing: true, plans: [plan('free')] };
    wrapper = mountIt(PricingPage);
    await flushPromises();
    expect(wrapper.find('[data-test="plan-organization"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('workspace switcher shows only with more than one workspace', async () => {
    signIn({ workspaceCount: 1 });
    let wrapper = mountIt(WorkspaceSwitcher);
    expect(wrapper.find('[data-test="workspace-switcher"]').exists()).toBe(false);
    wrapper.unmount();
    signIn({ workspaceCount: 2 });
    wrapper = mountIt(WorkspaceSwitcher);
    await flushPromises();
    expect(wrapper.find('[data-test="workspace-switcher"]').text()).toContain('Lan');
    wrapper.unmount();
  });
});
