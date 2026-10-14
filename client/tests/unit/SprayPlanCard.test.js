import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { createRouter, createMemoryHistory } from 'vue-router';

const plan = {
  today: '2026-10-14',
  items: [
    { farm: 'Hoa Loc', plot: 'Mango A', traps: 2, serials: ['A1', 'A2'], atThreshold: 2, ftd7: 5.1, action: 'treat_now', date: '2026-10-14', rotateFrom: 'Spinetoram' },
    { farm: 'Hoa Loc', plot: 'Pomelo B', traps: 1, serials: ['B1'], atThreshold: 1, action: 'wait_check', waitUntil: '2026-10-16', date: null },
    { farm: 'Hoa Loc', plot: 'Lime C', traps: 1, serials: ['C1'], atThreshold: 0, action: 'monitor', date: null }
  ]
};
vi.mock('@/services/api', () => ({ default: { getSprayPlan: vi.fn(async () => ({ data: plan })) } }));

const { default: i18n } = await import('@/i18n');
const { default: SprayPlanCard } = await import('@/components/dashboard/SprayPlanCard.vue');

async function mountCard() {
  i18n.global.locale.value = 'en';
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/logbook', component: { template: '<div />' } }] });
  await router.push('/');
  const wrapper = mount(SprayPlanCard, { global: { plugins: [i18n, ElementPlus, router] } });
  await flushPromises();
  return { wrapper, router };
}
const button = (wrapper, row, text) => wrapper.findAll('.plan-row')[row].findAll('button').find((b) => b.text() === text);

describe('To do card', () => {
  beforeEach(() => localStorage.clear());

  it('lists what needs doing, with a reminder to change the ingredient', async () => {
    const { wrapper } = await mountCard();
    const rows = wrapper.findAll('.plan-row');
    expect(rows.map((r) => r.find('.plan-place').text())).toEqual(['Hoa Loc · Mango A', 'Hoa Loc · Pomelo B']);
    expect(rows[0].text()).toContain('Spinetoram');
    // Nothing to log for "check the effect"
    expect(button(wrapper, 1, 'Done')).toBeUndefined();
  }, 20000);

  it('"Done" opens the field log form filled in; "Later" hides it for today', async () => {
    const { wrapper, router } = await mountCard();
    await button(wrapper, 0, 'Done').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/logbook');
    expect(router.currentRoute.value.query).toEqual({ new: '1', type: 'spray', cameras: 'A1,A2', area: 'Mango A' });

    await button(wrapper, 0, 'Later').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('.plan-row').map((r) => r.find('.plan-place').text())).toEqual(['Hoa Loc · Pomelo B']);
    expect(JSON.parse(localStorage.getItem('flybot_plan_snoozed'))).toEqual({ 'Hoa Loc|Mango A|treat_now': '2026-10-14' });
  }, 20000);
});
