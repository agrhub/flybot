import { useI18n } from 'vue-i18n';
import { SUPPORTED_LOCALES } from '@/i18n';
import api from '@/services/api';

/**
 * Switch the UI language, remember it locally, and save it to the account
 * (when signed in) so emails arrive in the same language.
 */
export function useLanguage() {
  const { locale } = useI18n();

  const setAppLocale = (code) => {
    if (!SUPPORTED_LOCALES.some((l) => l.code === code)) return;
    locale.value = code;
    try {
      localStorage.setItem('flybot_language', code);
    } catch (e) {}

    let signedIn = false;
    try {
      signedIn = !!localStorage.getItem('token');
    } catch (e) {}
    if (signedIn) {
      api.updateProfile({ language: code })
        .then((res) => {
          if (res.data?.user) localStorage.setItem('user', JSON.stringify(res.data.user));
        })
        .catch(() => {});
    }
  };

  return { locale, locales: SUPPORTED_LOCALES, setAppLocale };
}

export default useLanguage;
