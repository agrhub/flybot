const { ExpertReview } = require('../models');
const { TOKEN, ROW_IDS, VERDICTS } = require('../config/expertReview');
const { sendServerError } = require('../utils/http');
const { createQuota } = require('../middlewares/rateLimit');
const mailService = require('../services/mailService');
const emailTemplates = require('../services/emailTemplates');
const { recipients } = require('./contactController');

const NOTE_MAX = 1000;
// "Send" emails the answers to the operator: a few times per hour is plenty
const sendQuota = createQuota({ windowMs: 60 * 60 * 1000, max: 10 });

const view = (doc) => ({
    total: ROW_IDS.length,
    answers: (doc?.answers || []).map(({ id, verdict, note, t }) => ({ id, verdict, note, t })),
    updatedAt: doc?.updatedAt || null,
    sentAt: doc?.sentAt || null
});

/** The page's answers, checked: known row ids once each, a known verdict, a short note. null when invalid. */
function cleanAnswers(raw) {
    if (!Array.isArray(raw) || raw.length > ROW_IDS.length) return null;
    const out = new Map();
    for (const a of raw) {
        if (!a || typeof a !== 'object') return null;
        const id = String(a.id || '');
        const verdict = a.verdict == null ? '' : String(a.verdict);
        const note = typeof a.note === 'string' ? a.note.trim() : '';
        if (!ROW_IDS.includes(id) || out.has(id) || (verdict && !VERDICTS.includes(verdict)) || note.length > NOTE_MAX) return null;
        const t = Number(a.t);
        out.set(id, { id, verdict, note, t: Number.isFinite(t) && t > 0 ? t : 0 });
    }
    return out;
}

/** GET /api/public/expert-review/:token: the answers saved so far (the page restores them on another device). */
async function getReview(req, res) {
    try {
        if (req.params.token !== TOKEN) return res.status(404).json({ success: false, message: 'Review not found.' });
        res.json({ success: true, ...view(await ExpertReview.findOne({ token: TOKEN }).lean()) });
    } catch (err) {
        sendServerError(res, err, { context: 'Expert review' });
    }
}

/**
 * POST /api/public/expert-review/:token { answers: [{ id, verdict, note, t }], send? }
 * Saves the reviewer's answers (no account: the page's path is the key). Per row, the answer changed last
 * wins, so an older tab cannot undo a newer answer. send: true also emails every answer to the operator.
 */
async function saveReview(req, res) {
    try {
        if (req.params.token !== TOKEN) return res.status(404).json({ success: false, message: 'Review not found.' });
        const incoming = cleanAnswers(req.body.answers);
        if (!incoming) return res.status(400).json({ success: false, message: 'The answers are not valid.' });

        const stored = await ExpertReview.findOne({ token: TOKEN }).lean();
        const merged = new Map((stored?.answers || []).map(a => [a.id, a]));
        for (const [id, a] of incoming) {
            if (!merged.has(id) || a.t >= (merged.get(id).t || 0)) merged.set(id, a);
        }
        const answers = ROW_IDS.filter(id => merged.has(id)).map(id => merged.get(id))
            .filter(a => a.verdict || a.note);

        const send = req.body.send === true;
        if (send && !sendQuota.take(TOKEN)) {
            res.setHeader('Retry-After', sendQuota.retryAfterSeconds(TOKEN));
            return res.status(429).json({ success: false, message: 'Too many attempts. Please try again later.' });
        }
        const update = { answers, ...(send ? { sentAt: new Date() } : {}) };
        const doc = await ExpertReview.findOneAndUpdate({ token: TOKEN }, { $set: update }, { upsert: true, new: true }).lean();

        let emailed = false;
        if (send) {
            for (const recipient of await recipients()) {
                mailService.queueMail(emailTemplates.expertReviewEmail({ to: recipient.email, language: recipient.language, answers, total: ROW_IDS.length }));
                emailed = true;
            }
        }
        res.json({ success: true, emailed, ...view(doc) });
    } catch (err) {
        sendServerError(res, err, { context: 'Expert review' });
    }
}

module.exports = { getReview, saveReview };
