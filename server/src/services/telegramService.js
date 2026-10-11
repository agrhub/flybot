const axios = require('axios');
const { User } = require('../models');
const { TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME } = require('../config/env');
const { translate, normalizeLanguage, SUPPORTED_LANGUAGES, alertTextKey } = require('../utils/i18n');
const { escapeHtml } = require('./emailTemplates');
const { consumeToken } = require('./authTokenService');

const POLL_TIMEOUT_SECONDS = 25;
const RETRY_DELAYS_MS = [2000, 10000, 60000];

let polling = false;
let pollAbort = null;

function isEnabled() {
    return !!(TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_USERNAME);
}

function apiUrl(method) {
    return `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
}

/**
 * Deep link that opens the bot with a one-time link code.
 */
function linkUrl(code) {
    return `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${encodeURIComponent(code)}`;
}

/**
 * Send one HTML message now. Throws on failure. If the user blocked the bot,
 * the link is removed so we stop trying.
 */
async function sendMessage(chatId, html) {
    try {
        const { data } = await axios.post(apiUrl('sendMessage'), {
            chat_id: chatId,
            text: html,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        }, { timeout: 10000 });
        return data;
    } catch (err) {
        const code = err.response?.data?.error_code;
        if (code === 403) {
            await User.updateOne({ 'telegram.chatId': String(chatId) }, { $unset: { telegram: 1 } }).catch(() => {});
            console.warn(`📨 Telegram chat ${chatId} blocked the bot; link removed.`);
        }
        throw err;
    }
}

/**
 * Send a file (e.g. a report PDF) with an HTML caption now. Throws on failure.
 */
async function sendDocument(chatId, { content, filename, contentType = 'application/pdf', caption = '' }) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('document', new Blob([content], { type: contentType }), filename);
    // Telegram captions are limited to 1024 characters
    if (caption) {
        form.append('caption', caption.slice(0, 1024));
        form.append('parse_mode', 'HTML');
    }
    try {
        const { data } = await axios.post(apiUrl('sendDocument'), form, { timeout: 30000 });
        return data;
    } catch (err) {
        if (err.response?.data?.error_code === 403) {
            await User.updateOne({ 'telegram.chatId': String(chatId) }, { $unset: { telegram: 1 } }).catch(() => {});
        }
        throw err;
    }
}

/**
 * Send in the background with retries (alerts must never block the caller).
 */
function queueMessage(chatId, html) {
    queueSend(() => sendMessage(chatId, html));
}

/** Same as queueMessage, for a file. */
function queueDocument(chatId, document) {
    queueSend(() => sendDocument(chatId, document));
}

function queueSend(send) {
    if (!isEnabled()) return;
    const attempt = async (index) => {
        try {
            await send();
        } catch (err) {
            // 403 (blocked) and 400 (bad chat) will not succeed on retry
            const code = err.response?.data?.error_code;
            if (code !== 403 && code !== 400 && index < RETRY_DELAYS_MS.length) {
                setTimeout(() => attempt(index + 1), RETRY_DELAYS_MS[index]).unref();
            } else {
                console.error('📨 Telegram message failed:', err.response?.data?.description || err.message);
            }
        }
    };
    attempt(0);
}

/**
 * Alert text for a notification (same wording as the alert emails).
 */
function formatAlert({ language, type, params, url }) {
    const lang = normalizeLanguage(language);
    // Params include user-chosen camera names: escape them for Telegram HTML
    const safe = Object.fromEntries(Object.entries(params || {}).map(([k, v]) => [k, escapeHtml(v)]));
    const lines = [
        `<b>${translate(lang, `${alertTextKey(type, params)}.subject`, safe)}</b>`,
        translate(lang, `${alertTextKey(type, params)}.body`, safe)
    ];
    if (url) lines.push(`<a href="${escapeHtml(url)}">${escapeHtml(translate(lang, 'email.alerts.button'))}</a>`);
    return lines.join('\n\n');
}

/**
 * Handle one incoming update from Telegram (only private-chat commands).
 */
async function handleUpdate(update) {
    const message = update?.message;
    if (!message?.text || message.chat?.type !== 'private') return;

    const chatId = String(message.chat.id);
    const text = message.text.trim();
    const [command, ...args] = text.split(/\s+/);
    const tgLanguage = SUPPORTED_LANGUAGES.includes(message.from?.language_code) ? message.from.language_code : undefined;
    const reply = (key, lang, params) => queueMessage(chatId, translate(lang || tgLanguage, `telegram.${key}`, params));

    if (command === '/start' || command.startsWith('/start@')) {
        const code = args[0];
        if (!code) return reply('welcome');
        const record = await consumeToken(code, 'telegram_link');
        const user = record && await User.findById(record.userId);
        if (!user) return reply('linkInvalid');

        // One chat belongs to one account: detach it from anyone else first
        await User.updateMany({ 'telegram.chatId': chatId, _id: { $ne: user._id } }, { $unset: { telegram: 1 } });
        user.set('telegram', { chatId, username: message.from?.username || '', linkedAt: new Date() });
        await user.save();
        return reply('linked', user.language, { email: escapeHtml(user.email) });
    }

    if (command === '/stop' || command.startsWith('/stop@')) {
        const result = await User.updateMany({ 'telegram.chatId': chatId }, { $unset: { telegram: 1 } });
        return reply(result.modifiedCount > 0 ? 'unlinked' : 'notLinked');
    }

    return reply('help');
}

/**
 * Long-poll Telegram for updates. Run on exactly one instance (the one with ENABLE_CRON),
 * since Telegram allows only one getUpdates consumer per bot.
 */
async function startPolling() {
    if (!isEnabled() || polling) return;
    polling = true;
    let offset = 0;
    try {
        // Polling does not work while a webhook is set
        await axios.post(apiUrl('deleteWebhook'), {}, { timeout: 10000 });
    } catch (err) {
        console.warn('📨 Telegram deleteWebhook failed:', err.message);
    }
    console.log(`📨 Telegram bot @${TELEGRAM_BOT_USERNAME} polling for messages.`);

    while (polling) {
        try {
            pollAbort = new AbortController();
            const { data } = await axios.get(apiUrl('getUpdates'), {
                params: { offset, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: JSON.stringify(['message']) },
                timeout: (POLL_TIMEOUT_SECONDS + 10) * 1000,
                signal: pollAbort.signal
            });
            for (const update of data?.result || []) {
                offset = update.update_id + 1;
                await handleUpdate(update).catch(err => console.error('📨 Telegram update error:', err.message));
            }
        } catch (err) {
            if (!polling) break;
            console.warn('📨 Telegram polling error:', err.response?.data?.description || err.message);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

function stopPolling() {
    polling = false;
    pollAbort?.abort();
}

module.exports = {
    isEnabled,
    linkUrl,
    sendMessage,
    sendDocument,
    queueMessage,
    queueDocument,
    formatAlert,
    handleUpdate,
    startPolling,
    stopPolling
};
