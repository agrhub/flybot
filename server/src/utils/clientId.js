/**
 * An id the app gives a record it may have to send again (saved while offline, sent when the
 * signal is back). The same id from the same person means the same record: a second send
 * returns the first one instead of a duplicate.
 */
const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;

/** { value } (undefined when absent) or { error } */
function readClientId(body) {
    const id = body?.clientId;
    if (id === undefined || id === null || id === '') return { value: undefined };
    if (typeof id !== 'string' || !CLIENT_ID.test(id)) return { error: "clientId must be 8 to 64 letters, digits or dashes." };
    return { value: id };
}

const isDuplicateKey = (err) => err?.code === 11000;

module.exports = { readClientId, isDuplicateKey };
