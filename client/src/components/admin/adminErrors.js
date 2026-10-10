// Error codes returned by the admin API that have a translated message
const KNOWN_CODES = ['SELF_CHANGE', 'LAST_ADMIN', 'OWNS_CAMERAS', 'NOT_MANAGER', 'USER_NOT_FOUND'];

export function adminErrorText(t, err) {
  const data = err?.response?.data || {};
  if (KNOWN_CODES.includes(data.code)) return t(`admin.errors.${data.code}`, { count: data.cameraCount || 0 });
  return data.message || t('common.error');
}
