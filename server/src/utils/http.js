/**
 * Log an unexpected error server-side and send a generic 500 response,
 * so internal details (stack traces, DB/S3/EZVIZ messages) never reach the client.
 * `format: 'ezviz'` matches the { code, msg } shape used by the stream endpoints.
 */
function sendServerError(res, err, { format = 'default', context = '' } = {}) {
    console.error(`⚠️ ${context || 'Request'} failed:`, err);
    if (format === 'ezviz') {
        return res.status(500).json({ code: "500", msg: "Internal server error." });
    }
    return res.status(500).json({ success: false, message: "Internal server error." });
}

/**
 * Minimal Cookie header parser (avoids adding cookie-parser for one value).
 */
function parseCookies(header = '') {
    const cookies = {};
    header.split(';').forEach(part => {
        const idx = part.indexOf('=');
        if (idx < 0) return;
        const key = part.slice(0, idx).trim();
        if (!key) return;
        try {
            cookies[key] = decodeURIComponent(part.slice(idx + 1).trim());
        } catch {
            cookies[key] = part.slice(idx + 1).trim();
        }
    });
    return cookies;
}

module.exports = {
    sendServerError,
    parseCookies
};
