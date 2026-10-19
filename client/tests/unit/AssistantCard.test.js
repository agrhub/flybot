import { describe, it, expect, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { createRouter, createMemoryHistory } from 'vue-router';

vi.mock('@/services/api', () => ({ default: { getImageUrl: (key) => `/api/s3/${key}` } }));

const { default: i18n } = await import('@/i18n');
const { default: AssistantCard } = await import('@/components/assistant/AssistantCard.vue');

async function mountCard(card) {
  i18n.global.locale.value = 'en';
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] });
  await router.push('/');
  const wrapper = mount(AssistantCard, { props: { card }, global: { plugins: [i18n, ElementPlus, router] } });
  await flushPromises();
  return wrapper;
}

describe('Assistant confirm card', () => {
  it('a camera action from Sentinel is named in words and lists its trap and settings, not treatment fields', async () => {
    const wrapper = await mountCard({
      type: 'confirm',
      action: 'set_interval',
      state: 'pending',
      source: 'sentinel',
      reason: 'Flies are rising: photos more often for a day',
      summary: { trap: 'Vinh Long', trapKind: 'lure', action: 'set_interval', params: { minutes: 15 } },
    });
    expect(wrapper.find('.card-title').text()).toBe('Change the capture interval');
    expect(wrapper.text()).toContain('Vinh Long');
    expect(wrapper.text()).toContain('minutes=15');
    expect(wrapper.text()).not.toContain('Treatment:');
    expect(wrapper.text()).not.toContain('assistant.cards');
  });

  it('the reason follows the language on screen when the Lambda sent both', async () => {
    const card = { type: 'confirm', action: 'capture_now', state: 'pending', source: 'sentinel', reason: 'Có vật lớn che bẫy: ảnh không đếm, chụp lại',
      reasonI18n: { vi: 'Có vật lớn che bẫy: ảnh không đếm, chụp lại', en: 'A large object covers the trap: photo not counted, capture again' }, summary: { trap: 'Cu Chi', params: {} } };
    expect((await mountCard(card)).text()).toContain('A large object covers the trap');
    // Older cards have only the stored text
    const { reasonI18n, ...older } = card;
    expect((await mountCard(older)).text()).toContain('Có vật lớn che bẫy');
  });

  it('a review request has a title in both languages', async () => {
    const card = { type: 'confirm', action: 'review_request', state: 'pending', source: 'sentinel', summary: { trap: 'Cu Chi', params: {} } };
    expect((await mountCard(card)).find('.card-title').text()).toBe('Ask a person to check the trap');
    i18n.global.locale.value = 'vi';
    const wrapper = mount(AssistantCard, { props: { card }, global: { plugins: [i18n, ElementPlus] } });
    expect(wrapper.find('.card-title').text()).toBe('Nhờ người kiểm tra bẫy');
    i18n.global.locale.value = 'en';
  });
});
