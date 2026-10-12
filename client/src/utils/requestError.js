// Text for a failed request, in the app's language: no network, the server's own (translated)
// message, or the given fallback. Library messages such as axios' "Network Error" are English.
export function requestErrorText(t, err, fallback) {
  const noNetwork = err && !err.response && (err.code === 'ERR_NETWORK' || err.message === 'Network Error'
    || (typeof navigator !== 'undefined' && navigator.onLine === false));
  if (noNetwork) return t('offline.noConnection');
  if (err?.response?.data?.message) return err.response.data.message;
  // An error the app raised itself carries a message meant for the user (e.g. the camera
  // service's own reason); axios' ones ("Request failed with status code 500") do not
  if (err && !err.isAxiosError && err.message) return err.message;
  return fallback || t('common.error');
}
