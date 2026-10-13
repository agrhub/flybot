const { User } = require('../models');
const { sendServerError } = require('../utils/http');
const { translate, normalizeLanguage } = require('../utils/i18n');
const { escapeHtml } = require('../services/emailTemplates');
const { createToken } = require('../services/authTokenService');
const telegramService = require('../services/telegramService');

const LINK_TTL_MINUTES = 15;

function requireEnabled(res) {
    if (telegramService.isEnabled()) return true;
    res.status(503).json({ success: false, code: 'TELEGRAM_DISABLED', message: "Telegram alerts are not configured on this server." });
    return false;
}

/**
 * POST /api/telegram/link: one-time deep link that connects this account when the user presses Start
 */
async function createLink(req, res) {
    if (!requireEnabled(res)) return;
    try {
        const code = await createToken(req.user.id, 'telegram_link', LINK_TTL_MINUTES * 60 * 1000);
        res.json({
            success: true,
            url: telegramService.linkUrl(code),
            expiresAt: new Date(Date.now() + LINK_TTL_MINUTES * 60 * 1000)
        });
    } catch (err) {
        sendServerError(res, err, { context: 'Telegram link' });
    }
}

/**
 * DELETE /api/telegram/link: disconnect the Telegram chat
 */
async function unlink(req, res) {
    try {
        await User.updateOne({ _id: req.user.id }, { $unset: { telegram: 1 } });
        res.json({ success: true });
    } catch (err) {
        sendServerError(res, err, { context: 'Telegram unlink' });
    }
}

/**
 * POST /api/telegram/test: send a test message to the linked chat
 */
async function sendTest(req, res) {
    if (!requireEnabled(res)) return;
    try {
        const user = await User.findById(req.user.id);
        if (!user?.telegram?.chatId) {
            return res.status(400).json({ success: false, code: 'TELEGRAM_NOT_LINKED', message: "Telegram is not connected." });
        }
        await telegramService.sendMessage(
            user.telegram.chatId,
            translate(normalizeLanguage(user.language), 'telegram.test', { email: escapeHtml(user.email) })
        );
        res.json({ success: true });
    } catch (err) {
        if (err.response?.data?.error_code === 403) {
            return res.status(410).json({ success: false, code: 'TELEGRAM_BLOCKED', message: "The bot was blocked in Telegram; connect again." });
        }
        sendServerError(res, err, { context: 'Telegram test' });
    }
}

module.exports = {
    createLink,
    unlink,
    sendTest
};
