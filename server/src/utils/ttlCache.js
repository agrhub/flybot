/**
 * Small in-memory cache with a time-to-live and a size cap (oldest entries evicted first).
 * Per process: fine for data that may be a little stale (public dashboards, usage figures).
 */
function createTtlCache({ ttlMs, maxEntries = 500 }) {
    const entries = new Map(); // key -> { value, expiresAt }; Map keeps insertion order

    function get(key) {
        const entry = entries.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= Date.now()) {
            entries.delete(key);
            return undefined;
        }
        return entry.value;
    }

    function set(key, value) {
        entries.delete(key);
        entries.set(key, { value, expiresAt: Date.now() + ttlMs });
        while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
        return value;
    }

    // Cached value, or compute it once (concurrent callers share the same promise)
    async function wrap(key, compute) {
        const hit = get(key);
        if (hit !== undefined) return hit;
        const pending = compute();
        set(key, pending);
        try {
            const value = await pending;
            set(key, value);
            return value;
        } catch (err) {
            entries.delete(key);
            throw err;
        }
    }

    return { get, set, wrap, delete: (key) => entries.delete(key), clear: () => entries.clear(), get size() { return entries.size; } };
}

module.exports = { createTtlCache };
