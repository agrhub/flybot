const { User } = require('../models');
const env = require('../config/env');
const { sendServerError } = require('../utils/http');
const { normalizeLanguage } = require('../utils/i18n');
const mailService = require('../services/mailService');
const emailTemplates = require('../services/emailTemplates');
const { EMAIL_REGEX, normalizeEmail } = require('./shareController');

const LIMITS = { name: 100, subject: 150, message: 3000 };

const singleLine = (value, max) => (typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) : '');

/** Where contact messages go: CONTACT_EMAIL, or else every active admin with a confirmed address. */
async function recipients() {
    const configured = String(env.CONTACT_EMAIL || '').split(',').map(e => e.trim()).filter(e => EMAIL_REGEX.test(e));
    if (configured.length) return configured.map(email => ({ email, language: 'vi' }));
    const admins = await User.find({ role: 'admin', disabled: { $ne: true }, emailVerified: true }).select('email language').lean();
    return admins.map(a => ({ email: a.email, language: normalizeLanguage(a.language) }));
}

/**
 * POST /api/public/contact { name, email, subject?, message, website? }
 * The public contact form, emailed to the operator. "website" is a hidden field people never
 * fill in: when it has a value the sender is a bot, which gets the same answer and no email.
 */
async function submitContact(req, res) {
    try {
        const name = singleLine(req.body.name, LIMITS.name);
        const email = normalizeEmail(req.body.email);
        const subject = singleLine(req.body.subject, LIMITS.subject);
        const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
        if (!name || !message) return res.status(400).json({ success: false, message: "Please enter your name and a message." });
        if (!EMAIL_REGEX.test(email) || email.length > 254) {
            return res.status(400).json({ success: false, message: "Please enter a valid email address." });
        }
        if (message.length > LIMITS.message) {
            return res.status(400).json({ success: false, message: `Message is too long (at most ${LIMITS.message} characters).` });
        }
        if (req.body.website) return res.json({ success: true });

        const to = await recipients();
        if (!to.length) return res.status(503).json({ success: false, message: "The contact form is not available right now." });
        for (const recipient of to) {
            mailService.queueMail(emailTemplates.contactEmail({ to: recipient.email, language: recipient.language, name, email, subject, message }));
        }
        res.json({ success: true });
    } catch (err) {
        sendServerError(res, err, { context: 'Contact form' });
    }
}

module.exports = {
    submitContact
};
