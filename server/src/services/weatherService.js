const axios = require('axios');

/**
 * Current weather from Open-Meteo (free, no API key). Cached per ~1 km cell so the
 * dashboard does not call the API on every request. Returns null when unavailable.
 */
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map(); // "lat,lng" -> { at, value }

async function getCurrentWeather(latitude, longitude) {
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

    try {
        const { data } = await axios.get('https://api.open-meteo.com/v1/forecast', {
            params: {
                latitude: lat.toFixed(4),
                longitude: lng.toFixed(4),
                current: 'temperature_2m,relative_humidity_2m',
                timezone: 'auto'
            },
            timeout: 4000
        });
        const current = data?.current;
        if (!current || typeof current.temperature_2m !== 'number') return null;
        const value = {
            temperature: Math.round(current.temperature_2m * 10) / 10,
            humidity: Math.round(current.relative_humidity_2m),
            observedAt: current.time,
            source: 'open-meteo'
        };
        cache.set(key, { at: Date.now(), value });
        return value;
    } catch (err) {
        console.warn('⚠️ Weather lookup failed:', err.message);
        return null;
    }
}

/**
 * How the weather affects fruit fly activity (stable key; text lives in the client i18n files).
 * Bactrocera breed fastest around 25-33°C with high humidity.
 */
function weatherFactor(weather) {
    if (!weather) return null;
    const { temperature, humidity } = weather;
    if (temperature >= 25 && temperature <= 33 && humidity >= 70) return 'hot_humid';
    if (temperature < 18) return 'cool';
    if (temperature > 35) return 'very_hot';
    if (humidity < 50) return 'dry';
    return 'moderate';
}

module.exports = {
    getCurrentWeather,
    weatherFactor
};
