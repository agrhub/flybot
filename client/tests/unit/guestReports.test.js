import { describe, it, expect, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { createRouter, createMemoryHistory } from 'vue-router';

vi.mock('@/services/api', () => ({
  default: {
    listDashboards: vi.fn(async () => ({ data: { dashboards: [] } })),
    getCameras: vi.fn(async () => ({ data: { success: true, cameras: [
      { deviceSerial: 'BD1234567', deviceName: 'Bình Dương', access: 'demo', canManage: false },
      { deviceSerial: 'DEMO-4AC087016B', deviceName: 'Vĩnh Long', access: 'demo', canManage: false }
    ] } })),
    updateDashboard: vi.fn(async () => ({ data: { dashboard: {} } }))
  }
}));

const { default: i18n } = await import('@/i18n');
const { useAuth } = await import('@/composables/useAuth');
const { default: ReportsPage } = await import('@/pages/dashboards/index.vue');
const { default: DashboardShareDialog } = await import('@/components/dashboards/DashboardShareDialog.vue');

const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/reports/:id', component: { template: '<div />' } }] });
const signIn = (extra = {}) => useAuth().setAuth({ id: 'g1', email: 'guest@flybot.invalid', role: 'user', capabilities: { buildDashboards: true }, ...extra });
const mountIt = (component, props = {}) => mount(component, { props, global: { plugins: [ElementPlus, i18n, router] }, attachTo: document.body });

describe('reports made by a guest', () => {
  it('the guest gets New report, with every camera it sees and a note that the report is this visit\'s', async () => {
    i18n.global.locale.value = 'en';
    signIn({ guest: true });
    const wrapper = mountIt(ReportsPage);
    await flushPromises();
    // The camera list the app shell loads
    wrapper.vm.$.setupState.cameras = (await (await import('@/services/api')).default.getCameras()).data.cameras;
    const create = wrapper.findAll('button').find(b => b.text() === 'New report');
    expect(create).toBeTruthy();
    await create.trigger('click');
    await flushPromises();
    expect(document.body.querySelector('[data-test="guest-report-hint"]')).not.toBeNull();
    expect(wrapper.vm.$.setupState.form.cameraSerials).toEqual(['BD1234567', 'DEMO-4AC087016B']);
    wrapper.unmount();
  }, 20000);

  it('the share dialog offers the public link only, never email', async () => {
    i18n.global.locale.value = 'vi';
    signIn({ guest: true });
    const dashboard = { id: 'd1', name: 'Mine', visibility: 'private', canEdit: true, sharedWith: [] };
    const wrapper = mountIt(DashboardShareDialog, { modelValue: true, dashboard });
    await flushPromises();
    expect(document.body.querySelector('[data-test="guest-share-hint"]')).not.toBeNull();
    expect(document.body.querySelector('input[type="email"]')).toBeNull();
    wrapper.unmount();

    signIn({ guest: false });
    const owner = mountIt(DashboardShareDialog, { modelValue: true, dashboard });
    await flushPromises();
    expect(document.body.querySelector('[data-test="guest-share-hint"]')).toBeNull();
    expect(document.body.querySelector('input[type="email"]')).not.toBeNull();
    owner.unmount();
  }, 20000);
});
