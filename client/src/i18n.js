import { watch } from 'vue';
import { createI18n } from 'vue-i18n';
import en from './locales/en.json';
import vi from './locales/vi.json';

export const SUPPORTED_LOCALES = [
  { code: 'vi', label: 'Tiếng Việt', flag: '🇻🇳' },
  { code: 'en', label: 'English', flag: '🇺🇸' },
];

const SUPPORTED_CODES = SUPPORTED_LOCALES.map((l) => l.code);
// 'camhub_language' / 'smart_trap_lang' are legacy keys from earlier app names
const LANGUAGE_KEYS = ['flybot_language', 'camhub_language', 'smart_trap_lang'];

/** The language the visitor picked on this browser, or null when they never picked one. */
export function savedLocale(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
  try {
    for (const key of LANGUAGE_KEYS) {
      const code = storage?.getItem(key);
      if (SUPPORTED_CODES.includes(code)) return code;
    }
  } catch (e) {}
  return null;
}

/** First visit: Vietnamese for a browser set to Vietnamese, English for any other language. */
export function browserLocale(languages = typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : []) {
  const first = String(languages?.[0] || '').toLowerCase();
  return first === 'vi' || first.startsWith('vi-') ? 'vi' : 'en';
}

const i18n = createI18n({
  legacy: false,
  locale: savedLocale() || browserLocale(),
  fallbackLocale: 'vi',
  messages: {
    en,
    vi,
  },
});

// Screen readers pick their voice from <html lang>: keep it on the language shown
if (typeof document !== 'undefined') {
  watch(i18n.global.locale, (code) => { document.documentElement.lang = code; }, { immediate: true });
}

export default i18n;
