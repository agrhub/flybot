/**
 * The dashboard's "Realtime density by camera" list: its farms (for the filter) and the cameras that
 * match a search (name or serial), a farm, a status (online / offline) and a trap kind.
 */
export function farmsOf(list = []) {
  const farms = new Map();
  for (const cam of list) if (cam.farmId) farms.set(cam.farmId, cam.farmName || cam.farmId);
  return [...farms].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export function filterDensity(list = [], { search = '', farm = '', status = '', kind = '' } = {}) {
  const q = String(search).trim().toLowerCase();
  return list.filter(cam =>
    (!q || String(cam.deviceName || '').toLowerCase().includes(q) || String(cam.deviceSerial || '').toLowerCase().includes(q))
    && (!farm || cam.farmId === farm)
    && (!status || (status === 'online') === !!cam.status)
    && (!kind || cam.trapKind === kind));
}

/** One page of a list (pages from 1). */
export const pageOf = (list, page, size) => list.slice((page - 1) * size, page * size);
