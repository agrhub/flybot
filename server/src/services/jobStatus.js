/**
 * Last run of each background job (cron/scheduler.js), for the admin pipeline monitor.
 * Kept in memory: it starts empty when the server starts, and only the deployment that runs the
 * jobs (ENABLE_CRON) has any.
 */
const jobs = new Map();

const entryOf = (id) => {
    if (!jobs.has(id)) jobs.set(id, { id, running: false, runs: 0, failures: 0, skipped: 0, last: null });
    return jobs.get(id);
};

// A job's return value, when it is a small object of numbers and flags, is shown as its result
function summaryOf(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const entries = Object.entries(value).filter(([, v]) => ['number', 'boolean'].includes(typeof v));
    return entries.length ? Object.fromEntries(entries.slice(0, 8)) : null;
}

/**
 * Run `job` and record how it went. Returns what the job returned; rethrows its error.
 */
async function track(id, job) {
    const entry = entryOf(id);
    const startedAt = new Date();
    entry.running = true;
    entry.runs++;
    try {
        const value = await job();
        entry.last = { startedAt, finishedAt: new Date(), ok: true, error: null, result: summaryOf(value) };
        return value;
    } catch (err) {
        entry.failures++;
        entry.last = { startedAt, finishedAt: new Date(), ok: false, error: String(err?.message || err).slice(0, 300), result: null };
        throw err;
    } finally {
        entry.running = false;
    }
}

/** A tick skipped because the previous run was still going. */
function skipped(id) {
    entryOf(id).skipped++;
}

function list() {
    return [...jobs.values()].map(entry => ({ ...entry, last: entry.last && { ...entry.last } }));
}

module.exports = { track, skipped, list };
