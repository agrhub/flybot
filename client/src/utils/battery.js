/**
 * Battery tag text for a CamOS camera: "53 % · Charging", "53 % · Not charging", or "53 %" when the
 * camera does not say (older firmware, no charger signal). `battery` is device.battery { pct, charging }.
 */
export function batteryTagText(battery, t) {
  if (battery?.pct == null) return '';
  const state = battery.charging === true ? t('cameras.battery.charging') : battery.charging === false ? t('cameras.battery.notCharging') : '';
  return [`${battery.pct} %`, state].filter(Boolean).join(' · ');
}
