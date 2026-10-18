/**
 * Helpers of the CamOS camera settings form (components/cameras/CamosSettingsDialog.vue), kept pure for tests.
 */

/** The value the form starts from: what FlyBot asked for, else what the camera reports. */
export function effectiveValue(entry) {
  if (!entry) return null;
  return entry.desired !== null && entry.desired !== undefined ? entry.desired : entry.reported ?? null;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The fields whose form value differs from the starting value, as { path: value } for PUT device-settings.
 * An int left empty is null (only sent for nullable fields; otherwise it is not a change).
 */
export function changedSettings(fields, initial, current) {
  const out = {};
  for (const f of fields || []) {
    let v = current[f.path];
    if (v === undefined) v = null;
    if (v === null && !f.nullable && f.type !== 'window') continue;
    if (!same(v, initial[f.path])) out[f.path] = v;
  }
  return out;
}
