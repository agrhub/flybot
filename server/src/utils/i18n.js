/**
 * Minimal server-side translations (emails). UI text lives in the client i18n files.
 */
const messages = {
    en: require('../locales/en.json'),
    vi: require('../locales/vi.json')
};

const SUPPORTED_LANGUAGES = Object.keys(messages);
const DEFAULT_LANGUAGE = 'vi';

function normalizeLanguage(language) {
    return SUPPORTED_LANGUAGES.includes(language) ? language : DEFAULT_LANGUAGE;
}

function lookup(language, key) {
    return key.split('.').reduce((node, part) => (node == null ? node : node[part]), messages[language]);
}

/**
 * Translate `key` ("email.passwordReset.subject") with {param} interpolation.
 * Falls back to English, then to the key itself.
 */
function translate(language, key, params = {}) {
    const lang = normalizeLanguage(language);
    let text = lookup(lang, key);
    if (typeof text !== 'string') text = lookup('en', key);
    if (typeof text !== 'string') return key;
    return text.replace(/\{(\w+)\}/g, (match, name) => (params[name] !== undefined ? String(params[name]) : match));
}

/**
 * Locale key of an alert's subject/body. A lure-trap threshold alert compares the day's average
 * (params.basis = 'dailyAverage') and has its own wording.
 */
function alertTextKey(type, params) {
    return `email.alerts.${type}${params?.basis === 'dailyAverage' ? '_daily' : ''}`;
}

module.exports = {
    alertTextKey,
    SUPPORTED_LANGUAGES,
    DEFAULT_LANGUAGE,
    normalizeLanguage,
    translate
};
