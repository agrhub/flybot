const nodemailer = require('nodemailer');
const {
    SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM, APP_BASE_URL
} = require('../config/env');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
// Mail content (reset and confirmation links) is only printed for a local app address
const LOCAL_APP = !APP_BASE_URL || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(APP_BASE_URL);
const RETRY_DELAYS_MS = [2000, 10000, 60000];

let transporter = null;

function getTransporter() {
    if (!SMTP_HOST) return null;
    if (!transporter) {
        transporter = nodemailer.createTransport({
            host: SMTP_HOST,
            port: SMTP_PORT,
            secure: SMTP_SECURE,
            auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
            // Messages are built from our own templates; never let content pull local files or URLs
            disableFileAccess: true,
            disableUrlAccess: true
        });
    }
    return transporter;
}

function isMailConfigured() {
    return !!SMTP_HOST;
}

/**
 * Send one email now. Throws on failure.
 * Without SMTP configured: local development logs the message (so reset links can be tested);
 * production, or any non-local APP_BASE_URL, drops it with a warning that does not include the content.
 */
async function sendMail({ to, subject, html, text, replyTo, attachments }) {
    const transport = getTransporter();
    if (!transport) {
        if (IS_PRODUCTION || !LOCAL_APP) {
            console.warn(`📧 SMTP not configured; email "${subject}" was not sent.`);
        } else {
            console.log(`📧 [mail not configured, logging instead]\n  To: ${to}\n  Subject: ${subject}\n${text}\n`);
        }
        return { skipped: true };
    }
    return transport.sendMail({ from: MAIL_FROM, to, subject, html, text, ...(replyTo ? { replyTo } : {}), ...(attachments?.length ? { attachments } : {}) });
}

/**
 * Send in the background with retries, so a slow or failing SMTP server
 * never delays or breaks the request that triggered the email.
 */
function queueMail(message) {
    const attempt = async (index) => {
        try {
            await sendMail(message);
        } catch (err) {
            if (index < RETRY_DELAYS_MS.length) {
                setTimeout(() => attempt(index + 1), RETRY_DELAYS_MS[index]).unref();
            } else {
                console.error(`📧 Email "${message.subject}" failed after ${index + 1} attempts:`, err.message);
            }
        }
    };
    attempt(0);
}

module.exports = {
    isMailConfigured,
    sendMail,
    queueMail
};
