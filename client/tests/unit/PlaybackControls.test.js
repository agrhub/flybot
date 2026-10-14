import { describe, it, expect, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ElementPlus from 'element-plus';

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
// Three clips today: 01:00, 03:00, 05:30
const clips = ['01:00', '03:00', '05:30'].map((at) => ({ startTime: `${day} ${at}:00`, endTime: `${day} ${at.slice(0, 3)}20:00` }));

vi.mock('@/services/api', () => ({
  default: {
    getRecords: vi.fn(async () => ({ data: { data: clips } })),
    getHistory: vi.fn(async () => ({ data: { history: [] } })),
    getImageUrl: (key) => key
  }
}));

const { default: i18n } = await import('@/i18n');
const { default: PlaybackControls } = await import('@/components/cameras/PlaybackControls.vue');

describe('playback timeline from the keyboard', () => {
  it('arrows, Page Up/Down and Home/End play the clip next to the current one', async () => {
    i18n.global.locale.value = 'en';
    const wrapper = mount(PlaybackControls, { props: { camera: { deviceSerial: 'SN1' } }, global: { plugins: [i18n, ElementPlus] } });
    await flushPromises();
    const timeline = wrapper.find('[role="slider"]');
    expect(timeline.attributes('aria-label')).toMatch(/timeline/i);
    expect(timeline.attributes('tabindex')).toBe('0');

    const played = () => wrapper.emitted('play-playback').at(-1)[0].startTime;
    await timeline.trigger('keydown', { key: 'Home' });
    expect(played()).toBe(`${day} 01:00:00`);
    expect(timeline.attributes('aria-valuenow')).toBe('60');
    await timeline.trigger('keydown', { key: 'ArrowRight' });
    expect(played()).toBe(`${day} 03:00:00`);
    await timeline.trigger('keydown', { key: 'PageUp' });
    expect(played()).toBe(`${day} 05:30:00`);
    await timeline.trigger('keydown', { key: 'ArrowLeft' });
    expect(played()).toBe(`${day} 03:00:00`);
    await timeline.trigger('keydown', { key: 'End' });
    expect(played()).toBe(`${day} 05:30:00`);
    // Already at the last clip: nothing new to play
    const count = wrapper.emitted('play-playback').length;
    await timeline.trigger('keydown', { key: 'ArrowRight' });
    expect(wrapper.emitted('play-playback').length).toBe(count);
    // Mounting Element Plus can take seconds on a busy machine
  }, 20000);
});
