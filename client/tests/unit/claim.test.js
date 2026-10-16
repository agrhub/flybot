import { describe, it, expect, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { createRouter, createMemoryHistory } from 'vue-router';

vi.setConfig({ testTimeout: 30000 });

const claimCamera = vi.fn();
vi.mock('@/services/api', () => ({
  default: {
    claimCamera: (...args) => claimCamera(...args),
    listFarms: vi.fn(async () => ({ data: { farms: [{ id: 'f1', name: 'Lô A', canEdit: true }, { id: 'f2', name: 'Shared', canEdit: false }] } })),
    getImageUrl: (key) => `/api/s3/${key}`,
  },
}));

const { parseClaimCode } = await import('@/utils/claimCode');
const { default: i18n } = await import('@/i18n');
const { default: ClaimPage } = await import('@/pages/claim/index.vue');

describe('claim code', () => {
  it('reads the label QR and the claim link', () => {
    expect(parseClaimCode('CAMOS:1;SN:ESPF85B1B92877C;VC:9WBYWY;M:AIC-FREENOVE-S3CAM;;')).toEqual({ serial: 'ESPF85B1B92877C', verifyCode: '9WBYWY', model: 'AIC-FREENOVE-S3CAM' });
    expect(parseClaimCode('https://flybot.agrhub.com/claim?sn=espf85b1b92877c')).toEqual({ serial: 'ESPF85B1B92877C', verifyCode: '', model: '' });
    expect(parseClaimCode('hello')).toBeNull();
    expect(parseClaimCode('CAMOS:1;VC:9WBYWY;;')).toBeNull();
  });
});

const inputOf = (wrapper, key) => {
  const el = wrapper.find(`[data-test="${key}"]`);
  return el.element?.tagName === 'INPUT' ? el : wrapper.find(`[data-test="${key}"] input`);
};

describe('claim page', () => {
  const mountAt = async (url) => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/claim', name: 'claim', component: ClaimPage }, { path: '/cameras', component: { template: '<div />' } }] });
    router.push(url);
    await router.isReady();
    const wrapper = mount(ClaimPage, { global: { plugins: [ElementPlus, i18n, router] } });
    await flushPromises();
    return wrapper;
  };

  it('fills the serial from the link, claims, and shows the first photo', async () => {
    claimCamera.mockResolvedValueOnce({ data: { success: true, camera: { deviceSerial: 'ESPF85B1B92877C', deviceName: 'CamOS 877C' }, preview: { snapshotId: 's1', imageUrl: 'snapshots/ESPF85B1B92877C/a.jpg', count: 4 } } });
    const wrapper = await mountAt('/claim?sn=ESPF85B1B92877C');
    expect(inputOf(wrapper, 'serial').element.value).toBe('ESPF85B1B92877C');
    expect(wrapper.find('[data-test="claim-submit"]').attributes('disabled')).toBeDefined();
    await inputOf(wrapper, 'code').setValue('9wbywy');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(claimCamera).toHaveBeenCalledWith(expect.objectContaining({ serial: 'ESPF85B1B92877C', verifyCode: '9WBYWY', trapKind: 'lure', captureIntervalMinutes: 30 }));
    expect(wrapper.find('[data-test="claim-done"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="claim-preview"]').attributes('src')).toBe('/api/s3/snapshots/ESPF85B1B92877C/a.jpg');
  });

  it('turns a wrong code and a lock into plain messages', async () => {
    const wrapper = await mountAt('/claim?sn=ESPF85B1B92877C&vc=ZZZZZZ');
    claimCamera.mockRejectedValueOnce({ response: { status: 404, data: { code: 'NOT_FOUND' } } });
    expect(inputOf(wrapper, 'code').element.value).toBe('ZZZZZZ');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-test="claim-error"]').text()).toContain(i18n.global.t('claim.errors.notFound'));
    claimCamera.mockRejectedValueOnce({ response: { status: 429, data: { code: 'LOCKED' } } });
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-test="claim-error"]').text()).toContain(i18n.global.t('claim.errors.locked'));
  });
});
