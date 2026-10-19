import { describe, it, expect } from 'vitest';
import { compareVersions, formatSize, isOpenUpdate, updateProgress, updateTagType } from '@/utils/firmware';

describe('firmware helpers', () => {
  it('compares dotted versions numerically, a pre-release before its release', () => {
    expect(compareVersions('0.10.0', '0.9.3')).toBe(1);
    expect(compareVersions('0.6.3', '0.7.0')).toBe(-1);
    expect(compareVersions('v0.7.0', '0.7.0')).toBe(0);
    expect(compareVersions('0.7.0-rc1', '0.7.0')).toBe(-1);
    expect(compareVersions('0.7', '0.7.0')).toBe(0);
  });

  it('shows progress only while an update moves', () => {
    expect(updateProgress(null)).toBe(null);
    expect(updateProgress({ state: 'pending' })).toBe(null);
    expect(updateProgress({ state: 'sent' })).toBe(2);
    expect(updateProgress({ state: 'installing', progress: 50 })).toBe(45);
    expect(updateProgress({ state: 'installing' })).toBe(5);
    expect(updateProgress({ state: 'rebooting' })).toBe(95);
    expect(updateProgress({ state: 'succeeded' })).toBe(100);
  });

  it('tells open updates from finished ones and colours them', () => {
    expect(isOpenUpdate({ state: 'rebooting' })).toBe(true);
    expect(isOpenUpdate({ state: 'rolled_back' })).toBe(false);
    expect(updateTagType('succeeded')).toBe('success');
    expect(updateTagType('rolled_back')).toBe('danger');
    expect(updateTagType('whatever')).toBe('info');
  });

  it('formats image sizes', () => {
    expect(formatSize(1572864)).toBe('1.50 MB');
    expect(formatSize(655360)).toBe('640 KB');
  });
});
