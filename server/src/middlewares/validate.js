// Fields used directly in Mongo filters; an object here (e.g. { "$ne": null }) would act as a query operator
const STRING_FIELDS = ['deviceSerial', 'validateCode', 'urlId', 'id', 'sessionId'];

/**
 * Reject requests where identifier fields are not plain strings (NoSQL operator injection guard).
 */
function requireStringFields(req, res, next) {
    for (const source of [req.body, req.query]) {
        if (!source || typeof source !== 'object') continue;
        for (const field of STRING_FIELDS) {
            const value = source[field];
            if (value !== undefined && value !== null && typeof value !== 'string') {
                return res.status(400).json({ success: false, message: `Invalid ${field}.` });
            }
        }
    }
    next();
}

module.exports = {
    requireStringFields
};
