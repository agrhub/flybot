/**
 * Signal bars (0-4) of a camera's uplink from its RSSI in dBm, with the steps phones use: Wi-Fi -55 / -67 / -75 / -85,
 * 4G -85 / -95 / -105 / -115. 0 when there is no reading.
 */
export function signalBars(net, rssi) {
  const r = Number(rssi);
  if (rssi == null || rssi === '' || !Number.isFinite(r)) return 0;
  const steps = net === '4g' ? [-85, -95, -105, -115] : [-55, -67, -75, -85];
  const i = steps.findIndex((s) => r >= s);
  return i === -1 ? 0 : 4 - i;
}
