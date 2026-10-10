// Google map tiles shared by every Leaflet map in the app (street + satellite hybrid)
const GOOGLE_MAP_KEY = import.meta.env.VITE_GOOGLE_MAP_KEY || import.meta.env.GOOGLE_MAP_KEY || '';

export const FALLBACK_CENTER = [10.8231, 106.6297];

export function createBaseLayers(L) {
  const options = { maxZoom: 20, subdomains: ['0', '1', '2', '3'], attribution: '&copy; Google Maps' };
  return {
    street: L.tileLayer(`https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&key=${GOOGLE_MAP_KEY}`, options),
    satellite: L.tileLayer(`https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}&key=${GOOGLE_MAP_KEY}`, options),
  };
}
