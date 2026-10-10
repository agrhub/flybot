import { createI18n } from 'vue-i18n';
import en from './locales/en.json';
import vi from './locales/vi.json';

export const SUPPORTED_LOCALES = [
  { code: 'vi', label: 'Tiếng Việt', flag: '🇻🇳' },
  { code: 'en', label: 'English', flag: '🇺🇸' },
];

const savedLocale = (typeof localStorage !== 'undefined' && (localStorage.getItem('camhub_language') || localStorage.getItem('smart_trap_lang'))) || 'vi';

const i18n = createI18n({
  legacy: false,
  locale: savedLocale,
  fallbackLocale: 'vi',
  messages: {
    en,
    vi,
  },
});

export default i18n;
