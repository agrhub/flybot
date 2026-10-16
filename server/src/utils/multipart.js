/**
 * A small multipart/form-data parser for the device API (two parts: a JPEG and a JSON meta
 * block, a few MB at most). The whole body is already in memory (express.raw), so no
 * streaming library is needed. Returns [{ name, filename, contentType, data }].
 */
const CRLF = Buffer.from('\r\n');
const DOUBLE_CRLF = Buffer.from('\r\n\r\n');

function boundaryOf(contentType = '') {
    const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType));
    const boundary = (match?.[1] || match?.[2] || '').trim();
    return boundary || null;
}

function parseHeaders(text) {
    const headers = {};
    for (const line of text.split('\r\n')) {
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    return headers;
}

function parseDisposition(value = '') {
    const out = {};
    for (const piece of String(value).split(';').slice(1)) {
        const eq = piece.indexOf('=');
        if (eq < 0) continue;
        const key = piece.slice(0, eq).trim().toLowerCase();
        let val = piece.slice(eq + 1).trim();
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        out[key] = val;
    }
    return out;
}

/**
 * Parse `body` (a Buffer) with the boundary from `contentType`. Throws on a body that is not
 * multipart. At most `maxParts` parts are read.
 */
function parseMultipart(body, contentType, { maxParts = 8 } = {}) {
    const boundary = boundaryOf(contentType);
    if (!boundary) throw new Error('multipart/form-data without a boundary');
    const delimiter = Buffer.from(`--${boundary}`);
    const parts = [];
    let position = body.indexOf(delimiter);
    if (position < 0) throw new Error('multipart body without its boundary');
    position += delimiter.length;
    while (parts.length < maxParts) {
        // "--" right after a delimiter closes the body
        if (body.slice(position, position + 2).toString() === '--') break;
        // Skip the CRLF after the delimiter
        if (body.slice(position, position + 2).equals(CRLF)) position += 2;
        const headerEnd = body.indexOf(DOUBLE_CRLF, position);
        if (headerEnd < 0) throw new Error('multipart part without headers');
        const headers = parseHeaders(body.slice(position, headerEnd).toString('utf8'));
        const dataStart = headerEnd + DOUBLE_CRLF.length;
        const next = body.indexOf(delimiter, dataStart);
        if (next < 0) throw new Error('multipart part without an end');
        // The data ends before the CRLF that precedes the next delimiter
        const dataEnd = body.slice(next - 2, next).equals(CRLF) ? next - 2 : next;
        const disposition = parseDisposition(headers['content-disposition']);
        parts.push({
            name: disposition.name || '',
            filename: disposition.filename || null,
            contentType: (headers['content-type'] || '').split(';')[0].trim().toLowerCase() || null,
            data: body.slice(dataStart, dataEnd)
        });
        position = next + delimiter.length;
    }
    return parts;
}

module.exports = {
    boundaryOf,
    parseMultipart
};
