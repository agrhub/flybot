import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { createRouter, createMemoryHistory } from 'vue-router';

vi.setConfig({ testTimeout: 30000 });

// ---------- API mock ----------
const calls = { startCheckout: [], cancelRenewal: 0 };
let billingAnswer;
let paymentAnswer;
const proPrices = { VND: { month: 199000, year: 1990000, addonMonth: 30000, addonYear: 300000 }, USD: { month: 900, year: 9000, addonMonth: 150, addonYear: 1500 } };
const plan = (code, extra = {}) => ({ code, name: code.toUpperCase(), maxCameras: 3, snapshotsPerDay: 48, retentionDays: 30, deepAnalysisPerMonth: 20, liveMinutesPerRequest: 5, maxMembers: 1, features: { telegram: true, pdfReports: false, apiAndWebhooks: false }, priceNote: '', prices: { VND: {}, USD: {} }, visible: true, order: 1, ...extra });

vi.mock('@/services/api', () => ({
  default: {
    getPlans: vi.fn(async () => ({ data: { appMode: 'b2c', pricing: true, plans: [plan('free'), plan('pro', { prices: proPrices }), plan('enterprise')] } })),
    getBilling: vi.fn(async () => ({ data: billingAnswer })),
    startCheckout: vi.fn(async (body) => {
      calls.startCheckout.push(body);
      return { data: { checkout: { paymentId: 'p1', checkoutUrl: 'https://pay.payos.vn/web/plink_1' } } };
    }),
    getPayments: vi.fn(async () => ({ data: { payments: [
      { id: 'p1', status: 'paid', provider: 'payos', planCode: 'pro', interval: 'month', addonCameras: 2, amount: 259000, currency: 'VND', paidAt: '2026-10-16T05:00:00Z', periodStart: '2026-10-16T05:00:00Z', periodEnd: '2026-11-16T05:00:00Z', receiptNumber: 'FB-2026-0000ABCD', workspace: { id: 'w1', name: 'Lan' } },
    ] } })),
    getPayment: vi.fn(async () => ({ data: { payment: paymentAnswer } })),
    cancelRenewal: vi.fn(async () => {
      calls.cancelRenewal += 1;
      return { data: { success: true } };
    }),
    getEntitlements: vi.fn(async () => ({ data: { workspace: { id: 'w1', name: 'Lan', kind: 'personal', role: 'owner' }, entitlements: { plan: 'free', planName: 'FREE', exempt: false, expired: false, maxCameras: 3, snapshotsPerDay: 48, retentionDays: 30, deepAnalysisPerMonth: 20, liveMinutes: 5, maxMembers: 1, features: {} }, usage: { cameras: 0, members: 1, deepAnalyses: 0 } } })),
    getUpgradeRequests: vi.fn(async () => ({ data: { requests: [] } })),
    getMe: vi.fn(async () => ({ data: {} })),
  },
}));

const { default: i18n } = await import('@/i18n');
const { useAuth } = await import('@/composables/useAuth');
const { useCheckout, openCheckout } = await import('@/composables/useCheckout');
const { formatMoney, toMinor, fromMinor } = await import('@/utils/money');
const { default: PricingPage } = await import('@/pages/pricing/index.vue');
const { default: CheckoutDialog } = await import('@/components/plans/CheckoutDialog.vue');
const { default: BillingPanel } = await import('@/components/plans/BillingPanel.vue');
const { default: ReturnPage } = await import('@/pages/billing/Return.vue');

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/pricing', name: 'pricing', component: { template: '<div />' } },
    { path: '/settings', name: 'settings', component: { template: '<div />' } },
    { path: '/billing/return', name: 'billing-return', component: { template: '<div />' } },
  ],
});
const mountIt = (component) => mount(component, { global: { plugins: [ElementPlus, i18n, router] }, attachTo: document.body });
const signIn = () => useAuth().setAuth({ id: 'u1', email: 'lan@example.test', role: 'user', appMode: 'b2c', workspace: { id: 'w1', name: 'Lan', kind: 'personal', role: 'owner', plan: 'free' }, workspaceCount: 1, plan: { code: 'free', name: 'FREE' }, capabilities: { addCameras: true, pricing: true, upgradeRequests: true } });

// The checkout leaves for the provider's page
const realLocation = window.location;
const assign = vi.fn();
Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, assign } });
afterAll(() => Object.defineProperty(window, 'location', { configurable: true, value: realLocation }));

describe('online payment of plans', () => {
  beforeEach(() => {
    i18n.global.locale.value = 'en';
    calls.startCheckout.length = 0;
    calls.cancelRenewal = 0;
    assign.mockClear();
    useCheckout().state.open = false;
    billingAnswer = { enabled: true, isOwner: true, managed: false, graceDays: 7, currencies: ['VND', 'USD'], providers: [{ name: 'payos', recurring: false, currencies: ['VND'] }, { name: 'stripe', recurring: true, currencies: ['USD', 'VND'] }], plan: { code: 'free' }, billing: null };
    document.body.innerHTML = '';
  });

  it('money: smallest units in, formatted amounts out', () => {
    expect(toMinor(9.99, 'USD')).toBe(999);
    expect(toMinor(199000, 'VND')).toBe(199000);
    expect(fromMinor(900, 'USD')).toBe(9);
    expect(formatMoney(900, 'USD', 'en')).toBe('$9.00');
    expect(formatMoney(199000, 'VND', 'vi')).toMatch(/^199\.000\s?₫$/);
  });

  it('pricing page: prices per month or year, and Pay for the owner', async () => {
    signIn();
    const wrapper = mountIt(PricingPage);
    await flushPromises();
    expect(wrapper.find('[data-test="pricing-controls"]').exists()).toBe(true);
    // English picks USD first
    expect(wrapper.find('[data-test="plan-price-pro"]').text()).toBe('$9.00 / month');
    // ENTERPRISE has no price: still asked for
    expect(wrapper.find('[data-test="plan-ask-enterprise"]').exists()).toBe(true);
    await wrapper.findAll('[data-test="pricing-controls"] .el-radio-button')[1].trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="plan-price-pro"]').text()).toBe('$90.00 / year');
    await wrapper.find('[data-test="plan-pay-pro"]').trigger('click');
    expect(useCheckout().state.open).toBe(true);
    expect(useCheckout().state.options).toMatchObject({ planCode: 'pro', interval: 'year' });
    wrapper.unmount();
  });

  it('pricing page: a member (not the owner) asks for an upgrade instead', async () => {
    billingAnswer = { ...billingAnswer, isOwner: false };
    signIn();
    const wrapper = mountIt(PricingPage);
    await flushPromises();
    expect(wrapper.find('[data-test="plan-pay-pro"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="plan-ask-pro"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('checkout dialog: total with add-ons, then off to the provider', async () => {
    i18n.global.locale.value = 'vi';
    signIn();
    const wrapper = mountIt(CheckoutDialog);
    openCheckout({ planCode: 'pro' });
    await flushPromises();
    await flushPromises();
    const total = () => document.querySelector('[data-test="checkout-total"]').textContent;
    // Vietnamese picks VND and PayOS
    expect(total()).toMatch(/199\.000/);
    const addons = document.querySelector('[data-test="checkout-addons"] input');
    addons.value = '2';
    addons.dispatchEvent(new Event('input'));
    addons.dispatchEvent(new Event('change'));
    await flushPromises();
    expect(total()).toMatch(/259\.000/);
    document.querySelector('[data-test="checkout-pay"]').click();
    await flushPromises();
    expect(calls.startCheckout).toEqual([{ planCode: 'pro', interval: 'month', addonCameras: 2, currency: 'VND', provider: 'payos', upgradeRequestId: undefined }]);
    expect(assign).toHaveBeenCalledWith('https://pay.payos.vn/web/plink_1');
    wrapper.unmount();
  });

  it('billing panel: receipts, and stopping the automatic renewal', async () => {
    billingAnswer = { ...billingAnswer, plan: { code: 'pro', expiresAt: '2026-11-16T05:00:00Z' }, billing: { provider: 'stripe', autoRenew: true, pastDue: false } };
    signIn();
    const wrapper = mountIt(BillingPanel);
    await flushPromises();
    expect(wrapper.find('[data-test="billing-receipts"]').text()).toContain('PRO');
    expect(wrapper.find('[data-test="billing-receipts"]').text()).toContain('Paid');
    await wrapper.find('[data-test="billing-stop-renewal"]').trigger('click');
    await flushPromises();
    document.querySelector('.el-message-box__btns .el-button--primary').click();
    await flushPromises();
    expect(calls.cancelRenewal).toBe(1);
    wrapper.unmount();
  });

  it('return page: shows the new plan once the payment is confirmed', async () => {
    paymentAnswer = { id: 'p1', status: 'paid', planCode: 'pro', interval: 'month', amount: 199000, currency: 'VND', periodEnd: '2026-11-16T05:00:00Z', receiptNumber: 'FB-2026-0000ABCD' };
    signIn();
    await router.push('/billing/return?payment=p1');
    const wrapper = mountIt(ReturnPage);
    await flushPromises();
    expect(wrapper.find('[data-test="billing-return"]').text()).toContain('Thank you! You are on PRO');
    expect(wrapper.text()).toContain('FB-2026-0000ABCD');
    wrapper.unmount();
  });
});
