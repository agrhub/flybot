import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';

const { default: i18n } = await import('@/i18n');
const { default: DeviceSignal } = await import('@/components/cameras/DeviceSignal.vue');

const device = { net: '4g', rssi: -70, battery: { pct: 87, mv: 4080, charging: true }, power: { mode: 'powered', level: 'full' }, lastSeenAt: '2026-10-24T08:30:44Z' };
const view = (props) => mount(DeviceSignal, { props, global: { plugins: [i18n, ElementPlus] } });

describe('DeviceSignal', () => {
  it('online: the charging bolt blinks next to the battery', () => {
    i18n.global.locale.value = 'en';
    const w = view({ device });
    expect(w.find('[data-test="device-charging"]').exists()).toBe(true);
    expect(w.find('.device-signal').classes()).not.toContain('is-stale');
  });

  it('offline: the last report, greyed, and no charging bolt', () => {
    i18n.global.locale.value = 'en';
    const w = view({ device, online: false });
    expect(w.find('[data-test="device-charging"]').exists()).toBe(false);
    expect(w.find('.device-signal').classes()).toContain('is-stale');
    expect(w.find('.device-signal__battery').classes()).toContain('is-stale');
    expect(w.text()).toContain('87 %');
  });
});
