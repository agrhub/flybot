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
    expect(parseClaimCode('CAMOS:1;SN:ESP1234567890AB;VC:K7Q2MX;M:AIC-FREENOVE-S3CAM;;')).toEqual({ serial: 'ESP1234567890AB', verifyCode: 'K7Q2MX', model: 'AIC-FREENOVE-S3CAM' });
    expect(parseClaimCode('https://flybot.agrhub.com/claim?sn=esp1234567890ab')).toEqual({ serial: 'ESP1234567890AB', verifyCode: '', model: '' });
    expect(parseClaimCode('hello')).toBeNull();
    expect(parseClaimCode('CAMOS:1;VC:K7Q2MX;;')).toBeNull();
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
    claimCamera.mockResolvedValueOnce({ data: { success: true, camera: { deviceSerial: 'ESP1234567890AB', deviceName: 'CamOS 90AB' }, preview: { snapshotId: 's1', imageUrl: 'snapshots/ESP1234567890AB/a.jpg', count: 4 } } });
    const wrapper = await mountAt('/claim?sn=ESP1234567890AB');
    expect(inputOf(wrapper, 'serial').element.value).toBe('ESP1234567890AB');
    expect(wrapper.find('[data-test="claim-submit"]').attributes('disabled')).toBeDefined();
    await inputOf(wrapper, 'code').setValue('k7q2mx');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(claimCamera).toHaveBeenCalledWith(expect.objectContaining({ serial: 'ESP1234567890AB', verifyCode: 'K7Q2MX', trapKind: 'lure', captureIntervalMinutes: 30 }));
    expect(wrapper.find('[data-test="claim-done"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="claim-preview"]').attributes('src')).toBe('/api/s3/snapshots/ESP1234567890AB/a.jpg');
  });

  it('turns a wrong code and a lock into plain messages', async () => {
    const wrapper = await mountAt('/claim?sn=ESP1234567890AB&vc=ZZZZZZ');
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
