/**
 * Run `worker` over `items` with at most `limit` in flight, starting a new item no sooner
 * than `minStartGapMs` after the previous start (keeps bursts under external API rate limits).
 * Never rejects: a failing item is logged by the caller's worker and counted as failed.
 * Returns { done, failed }.
 */
async function runPool(items, { limit = 4, minStartGapMs = 0 } = {}, worker) {
    const queue = [...items];
    let nextStartAt = 0;
    let done = 0;
    let failed = 0;

    const waitForTurn = async () => {
        const now = Date.now();
        const startAt = Math.max(now, nextStartAt);
        nextStartAt = startAt + minStartGapMs;
        if (startAt > now) await new Promise(resolve => setTimeout(resolve, startAt - now));
    };

    const lane = async () => {
        while (queue.length) {
            const item = queue.shift();
            await waitForTurn();
            try {
                await worker(item);
                done++;
            } catch (err) {
                failed++;
            }
        }
    };

    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
    return { done, failed };
}

/**
 * At most `limit` tasks at a time; later calls wait their turn. When `maxQueue` calls are
 * already waiting, the call is refused with err.code = 'BUSY' instead of queueing.
 */
function createLimiter(limit = 2, { maxQueue = 20 } = {}) {
    let active = 0;
    const waiting = [];
    const next = () => {
        if (active >= limit || !waiting.length) return;
        active++;
        waiting.shift()();
    };
    return async function run(task) {
        if (active >= limit && waiting.length >= maxQueue) {
            throw Object.assign(new Error('Busy'), { code: 'BUSY' });
        }
        await new Promise(resolve => {
            waiting.push(resolve);
            next();
        });
        try {
            return await task();
        } finally {
            active--;
            next();
        }
    };
}

module.exports = { runPool, createLimiter };
