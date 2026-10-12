import { describe, it, expect } from 'vitest';
import { requestErrorText } from '@/utils/requestError';
import { latestOnly } from '@/utils/latestOnly';
import { rangeDays, sameDateRange, dateRangeLabel } from '@/utils/dateRange';
import { normalizeSpecies, speciesShare, normalizeSummary } from '@/utils/species';

const t = (key) => `t:${key}`;

describe('requestErrorText', () => {
  it('uses the server message when there is one', () => {
    expect(requestErrorText(t, { isAxiosError: true, response: { data: { message: 'Camera not found.' } } }, 'fallback')).toBe('Camera not found.');
  });

  it('says there is no connection on a network error', () => {
    expect(requestErrorText(t, { isAxiosError: true, code: 'ERR_NETWORK', message: 'Network Error' }, 'fallback')).toBe('t:offline.noConnection');
  });

  it('keeps the message of an error the app raised itself', () => {
    expect(requestErrorText(t, new Error('Device offline'), 'fallback')).toBe('Device offline');
  });

  it('hides axios\' English messages behind the fallback', () => {
    expect(requestErrorText(t, { isAxiosError: true, message: 'Request failed with status code 500', response: { data: {} } }, 'fallback')).toBe('fallback');
    expect(requestErrorText(t, { isAxiosError: true, message: 'Request failed', response: {} })).toBe('t:common.error');
  });
});

describe('latestOnly', () => {
  it('only the newest call stays current', () => {
    const track = latestOnly();
    const first = track();
    const second = track();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});

describe('date ranges', () => {
  it('counts the days of a range', () => {
    expect(rangeDays({ preset: '7d' })).toBe(7);
    expect(rangeDays({ preset: 'today' })).toBe(1);
    expect(rangeDays({ preset: 'custom', from: '2026-09-01', to: '2026-09-30' })).toBe(30);
    expect(rangeDays(undefined)).toBe(30);
  });

  it('compares and labels ranges', () => {
    expect(sameDateRange({ preset: '30d' }, undefined)).toBe(true);
    expect(sameDateRange({ preset: 'custom', from: 'a', to: 'b' }, { preset: 'custom', from: 'a', to: 'c' })).toBe(false);
    expect(dateRangeLabel(t, { preset: 'custom', from: '2026-09-01', to: '2026-09-30' })).toBe('01/09/2026 - 30/09/2026');
    expect(dateRangeLabel(t, { preset: '7d' })).toBe('t:filters.ranges.7d');
  });
});

describe('species labels', () => {
  it('reads older and Vietnamese labels as the canonical keys', () => {
    expect(normalizeSpecies('Ruồi vàng')).toBe('fruit_fly');
    expect(normalizeSpecies('Bactrocera dorsalis')).toBe('fruit_fly');
    expect(normalizeSpecies('bướm')).toBe('moth');
    expect(normalizeSpecies('beetle')).toBe('beetle');
  });

  it('localizes a share and merges a summary', () => {
    expect(speciesShare('fruit_fly (87%)', t)).toBe('t:species.fruitFly (87%)');
    expect(normalizeSummary({ 'ruồi vàng': 3, fruit_fly: 2 })).toMatchObject({ fruit_fly: 5 });
  });
});
