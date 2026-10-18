import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import QrCode from '@/components/common/QrCode.vue';

describe('QrCode', () => {
  it('draws the text as an SVG QR code of the asked size', () => {
    const w = mount(QrCode, { props: { text: 'CAMOS:1;K:abc;E:example-ats.iot.ap-southeast-2.amazonaws.com;U:https\://flybot.example;;', size: 120, label: 'QR code' } });
    const box = w.find('.qr-code');
    expect(box.attributes('role')).toBe('img');
    expect(box.attributes('aria-label')).toBe('QR code');
    expect(box.attributes('style')).toContain('120px');
    expect(w.find('svg').exists()).toBe(true);
    expect(w.html()).not.toContain('CAMOS:1', 'the text is not written into the markup');
  });

  it('draws nothing for an empty text', () => {
    const w = mount(QrCode, { props: { text: '' } });
    expect(w.find('svg').exists()).toBe(false);
  });
});
