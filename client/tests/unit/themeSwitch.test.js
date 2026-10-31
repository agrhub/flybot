import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ElementPlus from 'element-plus';

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/' }),
  useRouter: () => ({ push: vi.fn() })
}));

const { default: i18n } = await import('@/i18n');
const { useTheme } = await import('@/utils/theme');
const layouts = {
  HomeLayout: (await import('@/layouts/HomeLayout.vue')).default,
  DefaultLayout: (await import('@/layouts/DefaultLayout.vue')).default
};

describe('theme switch on the public layouts', () => {
  beforeEach(() => {
    const { isDark } = useTheme();
    isDark.value = true;
    localStorage.setItem('smart_trap_theme', 'dark');
  });

  for (const [name, layout] of Object.entries(layouts)) {
    it(`${name}: one click turns the light theme on, a second turns it off`, async () => {
      const wrapper = mount(layout, {
        global: { plugins: [ElementPlus, i18n], stubs: { RouterLink: true, RouterView: true, LanguageSelect: true } }
      });
      const { isDark } = useTheme();
      const sw = wrapper.find('.el-switch');

      await sw.trigger('click');
      await flushPromises();
      expect(isDark.value).toBe(false);
      expect(localStorage.getItem('smart_trap_theme')).toBe('light');
      expect(document.documentElement.classList.contains('dark')).toBe(false);

      await sw.trigger('click');
      await flushPromises();
      expect(isDark.value).toBe(true);
      expect(localStorage.getItem('smart_trap_theme')).toBe('dark');
      wrapper.unmount();
    });
  }
});
