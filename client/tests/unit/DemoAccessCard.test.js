import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ElementPlus from 'element-plus';

const OPEN = { live: true, playback: true, location: true, device: true, realSerial: true };
const settings = {
  demoViewEnabled: true, demoViewLive: false, guestAccessEnabled: true, demoViewAudience: 'guest',
  demoViewCameras: ['BD1234567'],
  demoViewShares: [{ deviceSerial: 'BD1234567', ...OPEN }]
};

vi.mock('@/services/api', () => ({
  default: {
    getAdminSettings: vi.fn(async () => ({ data: { settings } })),
    adminListCameras: vi.fn(async () => ({ data: { cameras: [
      { deviceSerial: 'BD1234567', deviceName: 'Bình Dương' },
      { deviceSerial: 'ESPA1B2C3D4E5F6', deviceName: 'Vĩnh Long' },
      { deviceSerial: 'SIM-001', deviceName: 'Simulated' }
    ] } })),
    adminDemoSim: vi.fn(async () => ({ data: { demoSim: { exists: false } } })),
    updateAdminSettings: vi.fn(async (body) => ({ data: { settings: { ...settings, ...body } } }))
  }
}));

const { default: api } = await import('@/services/api');
const { default: i18n } = await import('@/i18n');
const { default: DemoAccessCard } = await import('@/components/admin/DemoAccessCard.vue');
const { demoAllows, showsDemoDevice } = await import('@/utils/demoCamera');

async function mountCard(language = 'en') {
  i18n.global.locale.value = language;
  const wrapper = mount(DemoAccessCard, { global: { plugins: [i18n, ElementPlus] }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}
const switchOf = (wrapper, serial, permission) => wrapper.find(`[data-test="share-${serial}-${permission}"]`);

describe('Demo access: per-camera permissions', () => {
  beforeEach(() => api.updateAdminSettings.mockClear());

  it('lists each shared camera with its own switches and saves them', async () => {
    const wrapper = await mountCard();
    expect(wrapper.find('[data-test="demo-shares"]').text()).toContain('Bình Dương');
    for (const p of ['live', 'playback', 'location', 'device', 'realSerial']) {
      expect(switchOf(wrapper, 'BD1234567', p).classes()).toContain('is-checked');
    }
    await switchOf(wrapper, 'BD1234567', 'location').trigger('click');
    await wrapper.find('[data-test="demo-save"]').trigger('click');
    await flushPromises();
    const body = api.updateAdminSettings.mock.calls[0][0];
    expect(body.demoViewShares).toEqual([{ deviceSerial: 'BD1234567', ...OPEN, location: false }]);
    expect(body.demoViewCameras).toBeUndefined();
    wrapper.unmount();
  }, 20000);

  it('a new camera starts with its location, device details and serial hidden, live as the default switch says', async () => {
    const wrapper = await mountCard();
    wrapper.vm.$.setupState.addShare('ESPA1B2C3D4E5F6');
    await flushPromises();
    for (const p of ['live', 'playback', 'location', 'device', 'realSerial']) {
      expect(switchOf(wrapper, 'ESPA1B2C3D4E5F6', p).classes()).not.toContain('is-checked');
    }
    // Live view with a hidden serial: the admin is told the player gets the real one
    await switchOf(wrapper, 'ESPA1B2C3D4E5F6', 'live').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="demo-raw-serial"]').text()).toContain('Vĩnh Long');
    await wrapper.find('[data-test="share-BD1234567-remove"]').trigger('click');
    await wrapper.find('[data-test="demo-save"]').trigger('click');
    await flushPromises();
    expect(api.updateAdminSettings.mock.calls[0][0].demoViewShares).toEqual([
      { deviceSerial: 'ESPA1B2C3D4E5F6', live: true, playback: false, location: false, device: false, realSerial: false }
    ]);
    wrapper.unmount();
  }, 20000);

  it('reads settings saved before per-camera permissions as they behaved', async () => {
    api.getAdminSettings.mockResolvedValueOnce({ data: { settings: { ...settings, demoViewShares: undefined, demoViewLive: true } } });
    const wrapper = await mountCard('vi');
    for (const p of ['live', 'playback', 'location', 'device', 'realSerial']) {
      expect(switchOf(wrapper, 'BD1234567', p).classes()).toContain('is-checked');
    }
    expect(wrapper.text()).toContain('Số sê-ri thật');
    wrapper.unmount();
  }, 20000);
});

describe('Demo access: who sees the cameras', () => {
  beforeEach(() => api.updateAdminSettings.mockClear());

  it('"guest only" is one switch off, not a Demo switch that does nothing', async () => {
    // Saved before: Demo access on with the guest-only audience (the same as off for other accounts)
    const wrapper = await mountCard();
    expect(wrapper.find('[data-test="demo-enabled"]').classes()).not.toContain('is-checked');
    expect(wrapper.find('[data-test="demo-audience"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="guest-switch"]').classes()).toContain('is-checked');
    await wrapper.find('[data-test="demo-save"]').trigger('click');
    await flushPromises();
    expect(api.updateAdminSettings.mock.calls[0][0]).toMatchObject({ demoViewEnabled: false, demoViewAudience: 'guest', demoViewSince: null, guestAccessEnabled: true });

    // Other accounts too: every account by default
    await wrapper.find('[data-test="demo-enabled"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="demo-audience"]').exists()).toBe(true);
    await wrapper.find('[data-test="demo-save"]').trigger('click');
    await flushPromises();
    expect(api.updateAdminSettings.mock.calls[1][0]).toMatchObject({ demoViewEnabled: true, demoViewAudience: 'all', demoViewSince: null });
    wrapper.unmount();
  }, 20000);
});

describe('what a visitor may see of a camera', () => {
  it('follows camera.demo, and allows everything on other cameras', () => {
    expect(demoAllows({ access: 'owner' }, 'device')).toBe(true);
    expect(demoAllows({ access: 'demo', demo: { device: false } }, 'device')).toBe(false);
    expect(demoAllows({ access: 'demo', demo: { device: true } }, 'device')).toBe(true);
    expect(showsDemoDevice({ access: 'demo', demo: { device: true } })).toBe(true);
    expect(showsDemoDevice({ access: 'demo', demo: { device: false } })).toBe(false);
    expect(showsDemoDevice({ access: 'owner', canManage: true })).toBe(false);
  });
});
