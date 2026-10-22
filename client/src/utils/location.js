/**
 * A CamOS camera's reported position (device.location { lat, lng, source, accuracyM }). "cell" is the 4G
 * module's cell-tower estimate when the GPS has no fix; no source (older firmware) is a GPS fix.
 */
export const isCellLocation = (location) => location?.source === 'cell';

/** "10.12345, 106.12345", or "≈ 10.12345, 106.12345 (4G cell, ±550 m)" for a cell estimate. */
export function locationText(location, t) {
  if (location?.lat == null || location?.lng == null) return '';
  const coords = `${Number(location.lat).toFixed(5)}, ${Number(location.lng).toFixed(5)}`;
  if (!isCellLocation(location)) return coords;
  const how = location.accuracyM ? t('camosDevice.locationCell', { m: location.accuracyM }) : t('camosDevice.locationCellNoRadius');
  return `≈ ${coords} (${how})`;
}

/**
 * Radius in metres to draw around a camera on the map when its map position is the camera's cell estimate
 * (the position someone set by hand or a GPS fix gets none), else 0.
 */
export function approximateRadius(camera) {
  const l = camera?.device?.location;
  if (!isCellLocation(l) || !l.accuracyM) return 0;
  const same = Math.abs(Number(camera.latitude) - l.lat) < 1e-6 && Math.abs(Number(camera.longitude) - l.lng) < 1e-6;
  return same ? l.accuracyM : 0;
}
