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

module.exports = { runPool };
