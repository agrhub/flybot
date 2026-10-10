const { translate } = require('../utils/i18n');

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function displayName(user) {
    return user.name || (user.email || '').split('@')[0] || '';
}

/**
 * Build a simple, client-safe HTML email plus a plain-text version.
 * All text is escaped; only `button.url` (built by us) is used as a link.
 */
function layout({ language, user, paragraphs, button, footerKey = 'email.footer' }) {
    const t = (key, params) => translate(language, key, params);
    const greeting = t('email.greeting', { name: displayName(user) });
    const footer = t(footerKey);

    const htmlParagraphs = paragraphs
        .map(p => `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#334155">${escapeHtml(p)}</p>`)
        .join('');
    const htmlButton = button ? `
        <p style="margin:22px 0">
          <a href="${escapeHtml(button.url)}" style="display:inline-block;background:#10b981;color:#0f172a;font-weight:700;font-size:14px;text-decoration:none;padding:12px 22px;border-radius:12px">${escapeHtml(button.label)}</a>
        </p>
        <p style="margin:0 0 6px;font-size:12px;color:#64748b">${escapeHtml(t('email.linkFallback'))}</p>
        <p style="margin:0 0 14px;font-size:12px;word-break:break-all"><a href="${escapeHtml(button.url)}" style="color:#059669">${escapeHtml(button.url)}</a></p>` : '';

    const html = `<!doctype html>
<html lang="${escapeHtml(language)}"><body style="margin:0;padding:24px;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px;border:1px solid #e2e8f0">
    <p style="margin:0 0 18px;font-size:20px;font-weight:800;color:#0f172a">FlyBot<span style="color:#10b981">.</span></p>
    <p style="margin:0 0 14px;font-size:14px;color:#0f172a">${escapeHtml(greeting)}</p>
    ${htmlParagraphs}${htmlButton}
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:22px 0 14px">
    <p style="margin:0;font-size:11px;color:#94a3b8">${escapeHtml(footer)}</p>
  </div>
</body></html>`;

    const text = [
        greeting,
        '',
        ...paragraphs,
        ...(button ? ['', `${button.label}: ${button.url}`] : []),
        '',
        '--',
        footer
    ].join('\n');

    return { html, text };
}

function passwordResetEmail({ user, language, url, minutes }) {
    const t = (key, params) => translate(language, key, params);
    return {
        to: user.email,
        subject: t('email.passwordReset.subject'),
        ...layout({
            language,
            user,
            paragraphs: [t('email.passwordReset.intro'), t('email.passwordReset.expiry', { minutes }), t('email.passwordReset.ignore')],
            button: { label: t('email.passwordReset.button'), url }
        })
    };
}

function passwordChangedEmail({ user, language }) {
    const t = (key, params) => translate(language, key, params);
    return {
        to: user.email,
        subject: t('email.passwordChanged.subject'),
        ...layout({
            language,
            user,
            paragraphs: [t('email.passwordChanged.intro'), t('email.passwordChanged.notYou')]
        })
    };
}

function verifyEmailEmail({ user, language, url, hours }) {
    const t = (key, params) => translate(language, key, params);
    return {
        to: user.email,
        subject: t('email.verifyEmail.subject'),
        ...layout({
            language,
            user,
            paragraphs: [t('email.verifyEmail.intro'), t('email.verifyEmail.expiry', { hours })],
            button: { label: t('email.verifyEmail.button'), url }
        })
    };
}

function alertEmail({ user, language, type, params: rawParams, url }) {
    const t = (key, p) => translate(language, key, p);
    // Params include user-chosen camera names; keep them single-line and short for the subject header
    const params = Object.fromEntries(
        Object.entries(rawParams || {}).map(([k, v]) => [k, String(v ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 120)])
    );
    return {
        to: user.email,
        subject: t(`email.alerts.${type}.subject`, params),
        ...layout({
            language,
            user,
            paragraphs: [t(`email.alerts.${type}.body`, params)],
            button: url ? { label: t('email.alerts.button'), url } : null,
            footerKey: 'email.footerAlerts'
        })
    };
}

// Shared-item emails include names chosen by other users: keep them single-line and short
const singleLine = (value) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 120);

/**
 * "X shared <item> with you" for an existing account, or an invitation to sign up
 * for an email without an account. `kind` is 'cameraShared' | 'invite' | 'dashboardShared' | 'dashboardInvite' | 'farmShared' | 'farmInvite'.
 */
function shareEmail({ kind, to, user, language, sharer, params = {}, url }) {
    const t = (key, p) => translate(language, key, p);
    const safe = { sharer: singleLine(sharer), email: singleLine(to), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, singleLine(v)])) };
    return {
        to,
        subject: t(`email.${kind}.subject`, safe),
        ...layout({
            language,
            user: user || { email: to },
            paragraphs: [t(`email.${kind}.body`, safe)],
            button: url ? { label: t(`email.${kind}.button`), url } : null
        })
    };
}

/**
 * Weekly summary: one paragraph per line of services/reportService.reportLines.
 */
function weeklyReportEmail({ user, language, lines, url }) {
    const t = (key, params) => translate(language, key, params);
    return {
        to: user.email,
        subject: t('email.weeklyReport.subject'),
        ...layout({
            language,
            user,
            paragraphs: lines,
            button: url ? { label: t('email.weeklyReport.button'), url } : null,
            footerKey: 'email.weeklyReport.footer'
        })
    };
}

module.exports = {
    shareEmail,
    weeklyReportEmail,
    escapeHtml,
    passwordResetEmail,
    passwordChangedEmail,
    verifyEmailEmail,
    alertEmail
};
