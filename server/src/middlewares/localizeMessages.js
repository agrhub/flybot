const { SUPPORTED_LANGUAGES } = require('../utils/i18n');

/**
 * Translate the `message` of JSON responses into the language the app asks for
 * (X-Language header, sent by the web client).
 *
 * Controllers keep writing plain English messages. locales/<lang>.json "apiMessages" holds each
 * English text (with {name} where a value goes in) and its translation; a message that is not
 * in the table, and every response without the header (API users, tests), stays in English.
 */
const messages = Object.fromEntries(SUPPORTED_LANGUAGES.map(lang => [lang, require(`../locales/${lang}.json`).apiMessages || {}]));

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// English text -> matcher, built once
const matchers = Object.entries(messages.en).map(([key, pattern]) => {
    const names = [];
    const source = escapeRegex(pattern).replace(/\\\{(\w+)\\\}/g, (match, name) => {
        names.push(name);
        return '(.+?)';
    });
    const literal = pattern.replace(/\{\w+\}/g, '').length;
    return { key, names, literal, regex: new RegExp(`^${source}$`), exact: names.length === 0 ? pattern : null };
})
    // The most specific pattern wins ("Invalid count for {label}." before "Invalid {field}.")
    .sort((a, b) => b.literal - a.literal);
const exactKeys = new Map(matchers.filter(m => m.exact).map(m => [m.exact, m.key]));

function translateMessage(text, language) {
    const table = messages[language];
    if (!table || typeof text !== 'string') return text;
    const exact = exactKeys.get(text);
    if (exact) return table[exact] || text;
    for (const m of matchers) {
        if (m.exact) continue;
        const found = text.match(m.regex);
        if (!found || !table[m.key]) continue;
        const values = Object.fromEntries(m.names.map((name, i) => [name, found[i + 1]]));
        return table[m.key].replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match);
    }
    return text;
}

function localizeMessages(req, res, next) {
    const language = String(req.get('X-Language') || '').toLowerCase();
    if (language === 'en' || !messages[language]) return next();
    const json = res.json.bind(res);
    res.json = (body) => {
        if (body && typeof body === 'object' && typeof body.message === 'string') {
            body = { ...body, message: translateMessage(body.message, language) };
        }
        return json(body);
    };
    next();
}

module.exports = {
    translateMessage,
    localizeMessages
};
