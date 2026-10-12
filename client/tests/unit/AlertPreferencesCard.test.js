import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { createRouter, createMemoryHistory } from 'vue-router';

const user = { id: 'u1', email: 'lan@example.test', emailVerified: true, notificationPrefs: { email: true, weeklyReport: true, vietgapMonthly: false } };

vi.mock('@/services/api', () => ({
  default: {
    getCameras: vi.fn(async () => ({ data: { cameras: [] } })),
    getTelegramStatus: vi.fn(async () => ({ data: { configured: false } })),
    updateProfile: vi.fn(async (body = {}) => ({ data: { user: { ...user, notificationPrefs: { ...user.notificationPrefs, ...body.notificationPrefs } } } }))
  }
}));

// Signed in before the app modules load (useAuth reads it once)
localStorage.setItem('user', JSON.stringify(user));
const { default: api } = await import('@/services/api');
const { default: i18n } = await import('@/i18n');
const { useAuth } = await import('@/composables/useAuth');
const { default: AlertPreferencesCard } = await import('@/components/settings/AlertPreferencesCard.vue');
const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] });

async function mountCard(language) {
  i18n.global.locale.value = language;
  useAuth().setAuth(user);
  const wrapper = mount(AlertPreferencesCard, { global: { plugins: [i18n, ElementPlus, router] } });
  await flushPromises();
  return wrapper;
}

const cardWith = (wrapper, text) => wrapper.findAll('.el-card').filter(c => c.text().includes(text)).pop();

describe('notification settings', () => {
  beforeEach(() => api.updateProfile.mockClear());

  it('the monthly VietGAP switch saves the preference', async () => {
    const wrapper = await mountCard('vi');
    const card = cardWith(wrapper, 'Sổ VietGAP hằng tháng');
    expect(card).toBeTruthy();
    expect(card.text()).toContain('Ngày 1 hằng tháng lúc 7:00');
    expect(card.find('.el-switch').classes()).not.toContain('is-checked');

    await card.find('.el-switch').trigger('click');
    await flushPromises();
    expect(api.updateProfile).toHaveBeenCalledWith({ notificationPrefs: { vietgapMonthly: true } });
    expect(cardWith(wrapper, 'Sổ VietGAP hằng tháng').find('.el-switch').classes()).toContain('is-checked');
  });

  it('shows English labels in English', async () => {
    const wrapper = await mountCard('en');
    expect(cardWith(wrapper, 'Monthly VietGAP record')).toBeTruthy();
    expect(wrapper.text()).not.toContain('Sổ VietGAP');
  });
});
