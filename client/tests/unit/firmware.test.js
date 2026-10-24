import { describe, it, expect } from 'vitest';
import { compareVersions, formatSize, isOpenUpdate, updateProgress, updateTagType, CHANNELS, channelTagType, nextChannel, imageVersion } from '@/utils/firmware';

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

  it('promotes alpha to beta to stable', () => {
    expect(CHANNELS).toEqual(['alpha', 'beta', 'stable']);
    expect([nextChannel('alpha'), nextChannel('beta'), nextChannel('stable')]).toEqual(['beta', 'stable', null]);
    expect(channelTagType('alpha')).toBe('danger');
    expect(channelTagType(undefined)).toBe('success');
  });
});

describe('imageVersion', () => {
  const image = (version, { magic = true, head = 0xe9 } = {}) => {
    const b = new Uint8Array(256);
    b[0] = head;
    if (magic) b.set([0x32, 0x54, 0xcd, 0xab], 32);
    b.set(Array.from(version, (c) => c.charCodeAt(0)), 48);
    return b;
  };
  it('reads the version of an ESP32 application image', () => {
    expect(imageVersion(image('0.9.2-rc.1'))).toBe('0.9.2-rc.1');
    expect(imageVersion(image('v0.9.1').buffer)).toBe('0.9.1');
  });
  it('gives nothing for other files', () => {
    expect(imageVersion(image('0.9.2', { head: 0x50 }))).toBe('');
    expect(imageVersion(image('0.9.2', { magic: false }))).toBe('');
    expect(imageVersion(new Uint8Array(10))).toBe('');
  });
});
