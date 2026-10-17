import { describe, it, expect } from 'vitest';
import { browserLocale, savedLocale } from '@/i18n';

const storage = (values) => ({ getItem: (key) => (key in values ? values[key] : null) });

describe('browserLocale', () => {
  it('uses Vietnamese for a browser set to Vietnamese', () => {
    expect(browserLocale(['vi'])).toBe('vi');
    expect(browserLocale(['vi-VN', 'en-US'])).toBe('vi');
  });

  it('uses English for any other browser language', () => {
    expect(browserLocale(['en-US', 'vi'])).toBe('en');
    expect(browserLocale(['fr-FR'])).toBe('en');
    expect(browserLocale(['ja'])).toBe('en');
    expect(browserLocale([])).toBe('en');
    expect(browserLocale(undefined)).toBe('en');
  });
});

describe('savedLocale', () => {
  it('returns the language picked on this browser', () => {
    expect(savedLocale(storage({ flybot_language: 'en' }))).toBe('en');
    expect(savedLocale(storage({ camhub_language: 'vi' }))).toBe('vi');
  });

  it('is null when nothing (or nothing supported) was picked', () => {
    expect(savedLocale(storage({}))).toBeNull();
    expect(savedLocale(storage({ flybot_language: 'de' }))).toBeNull();
    expect(savedLocale(null)).toBeNull();
    expect(savedLocale({ getItem: () => { throw new Error('blocked'); } })).toBeNull();
  });
});
