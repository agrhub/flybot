import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Simulated-data banner', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('folds into the top-bar tag, opens again, and is remembered per browser', async () => {
    const { useSimulatedBanner } = await import('@/composables/useSimulatedBanner');
    const banner = useSimulatedBanner();
    expect(banner.collapsed.value).toBe(false);
    banner.collapse();
    expect(banner.collapsed.value).toBe(true);
    expect(localStorage.getItem('flybot.simulatedBanner.collapsed')).toBe('1');

    // A new page load reads the choice back
    vi.resetModules();
    const again = (await import('@/composables/useSimulatedBanner')).useSimulatedBanner();
    expect(again.collapsed.value).toBe(true);
    again.expand();
    expect(again.collapsed.value).toBe(false);
    expect(localStorage.getItem('flybot.simulatedBanner.collapsed')).toBe('0');
  });
});
