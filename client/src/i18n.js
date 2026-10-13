import { watch } from 'vue';
import { createI18n } from 'vue-i18n';
import en from './locales/en.json';
import vi from './locales/vi.json';

export const SUPPORTED_LOCALES = [
  { code: 'vi', label: 'Tiếng Việt', flag: '🇻🇳' },
  { code: 'en', label: 'English', flag: '🇺🇸' },
];

// 'camhub_language' / 'smart_trap_lang' are legacy keys from earlier app names
const savedLocale = (typeof localStorage !== 'undefined' && (localStorage.getItem('flybot_language') || localStorage.getItem('camhub_language') || localStorage.getItem('smart_trap_lang'))) || 'vi';

const i18n = createI18n({
  legacy: false,
  locale: savedLocale,
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
