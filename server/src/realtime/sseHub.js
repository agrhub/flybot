/**
 * Server-Sent Events hub: keeps open streams per user and pushes events to them.
 * In-memory, so it only reaches clients connected to this instance (one instance on Cloud Run).
 */
const HEARTBEAT_MS = 25000; // below typical proxy idle timeouts
const MAX_STREAMS_PER_USER = 5;

const clients = new Map(); // userId -> Set<res>

function write(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Register an SSE response for a user; returns once headers are sent.
 */
function addClient(userId, req, res) {
    res.status(200).set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no' // disable buffering behind nginx
    });
    res.flushHeaders();
    res.write('retry: 5000\n\n');

    let streams = clients.get(userId);
    if (!streams) {
        streams = new Set();
        clients.set(userId, streams);
    }
    // Cap open tabs per user; close the oldest stream
    if (streams.size >= MAX_STREAMS_PER_USER) {
        const oldest = streams.values().next().value;
        streams.delete(oldest);
        oldest.end();
    }
    streams.add(res);

    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    heartbeat.unref();

    req.on('close', () => {
        clearInterval(heartbeat);
        streams.delete(res);
        if (streams.size === 0) clients.delete(userId);
    });
}

function sendToUser(userId, event, data) {
    const streams = clients.get(String(userId));
    if (!streams) return 0;
    for (const res of streams) write(res, event, data);
    return streams.size;
}

function connectedCount() {
    let total = 0;
    for (const streams of clients.values()) total += streams.size;
    return total;
}

module.exports = {
    addClient,
    sendToUser,
    connectedCount
};
