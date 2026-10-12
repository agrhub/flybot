// Text for a failed request, in the app's language: no network, the server's own (translated)
// message, or the given fallback. Library messages such as axios' "Network Error" are English.
export function requestErrorText(t, err, fallback) {
  const noNetwork = err && !err.response && (err.code === 'ERR_NETWORK' || err.message === 'Network Error'
    || (typeof navigator !== 'undefined' && navigator.onLine === false));
  if (noNetwork) return t('offline.noConnection');
  return err?.response?.data?.message || fallback || t('common.error');
}
