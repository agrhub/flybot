const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { User, Session, Organization, Camera } = require('../models');
const { roleOf } = require('../constants/roles');

// Lazy: shareController pulls in notification/mail services
const claimPendingShares = (user) => require('./shareController').claimPendingShares(user)
    .catch(err => console.error('⚠️ Claiming shared items failed:', err.message));
const { signToken, setAuthCookie, clearAuthCookie, createSession, readToken, resolveToken } = require('../middlewares/auth');
const { sendServerError } = require('../utils/http');
const { recordAudit } = require('../services/auditService');
const { normalizeLanguage, SUPPORTED_LANGUAGES } = require('../utils/i18n');
const { queueMail } = require('../services/mailService');
const emailTemplates = require('../services/emailTemplates');
const avatarService = require('../services/avatarService');
const sentinelUi = require('../services/sentinelUiService');
const dataExportService = require('../services/dataExportService');
const { pipeSnapshot } = require('./s3Controller');
const {
    PASSWORD_RESET_TTL_MINUTES,
    EMAIL_VERIFY_TTL_HOURS,
    createToken,
    consumeToken,
    appUrl
} = require('../services/authTokenService');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 6;
// bcrypt only uses the first 72 bytes; cap length to avoid silent truncation and hashing DoS
const MAX_PASSWORD_LENGTH = 72;

function validatePassword(password) {
    if (typeof password !== 'string') return "Password is required.";
    if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
    return null;
}

// Emails are stored lowercase and looked up case-insensitively (older accounts may have capitals)
const readEmail = (body) => (typeof body.email === 'string' ? body.email.trim().toLowerCase() : '');
// Compared against when the account does not exist, so both cases take the same time
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('flybot-no-such-account', 10);
const findByEmail = (email) => User.findOne({ email }).collation({ locale: 'en', strength: 2 });

function toPublicUser(user) {
    return {
        id: user._id,
        email: user.email,
        name: user.name || user.email.split('@')[0],
        avatar: avatarService.avatarUrlOf(user),
        role: roleOf(user),
        emailVerified: !!user.emailVerified,
        language: normalizeLanguage(user.language),
        notificationPrefs: {
            email: user.notificationPrefs?.email !== false,
            telegram: user.notificationPrefs?.telegram !== false,
            weeklyReport: user.notificationPrefs?.weeklyReport !== false,
            morningBrief: !!user.notificationPrefs?.morningBrief,
            vietgapMonthly: !!user.notificationPrefs?.vietgapMonthly,
            orgDigest: user.notificationPrefs?.orgDigest !== false,
            quietHours: {
                enabled: !!user.notificationPrefs?.quietHours?.enabled,
                start: user.notificationPrefs?.quietHours?.start || '21:00',
                end: user.notificationPrefs?.quietHours?.end || '06:00'
            },
            mutedCameras: user.notificationPrefs?.mutedCameras || []
        },
        telegram: {
            connected: !!user.telegram?.chatId,
            username: user.telegram?.username || ''
        },
        // Sentinel console menu (sentinelEnabled) and its Approve/Reject buttons (sentinelCanDecide)
        ...sentinelUi.accessFor(user)
    };
}

/**
 * The profile the app keeps (toPublicUser) plus the current workspace, how many there are, the
 * plan and what the person may do there (capabilities, from the workspace role and the plan),
 * and APP_MODE. `req` gives the X-Workspace-Id the app asked for. The guest account
 * (services/guestAccess.js) may do nothing and learns when its session ends (`sessionId`, else
 * the request's).
 */
async function publicUser(user, req = null, { sessionId = null } = {}) {
    const base = toPublicUser(user);
    const workspaceService = require('../services/workspaceService');
    const entitlements = require('../services/entitlements');
    let docs = [];
    let current = null;
    try {
        docs = await workspaceService.workspaceDocsOf(user);
        const requested = String(req?.get?.('X-Workspace-Id') || '').trim();
        current = await workspaceService.currentOf(user, /^[a-f0-9]{24}$/i.test(requested) ? requested : null, docs);
    } catch (err) {
        console.warn('⚠️ Workspace not resolved for the profile:', err.message);
    }
    const workspace = current ? workspaceService.viewOf(current, String(user._id)) : null;
    const ctx = { id: String(user._id), email: user.email, role: roleOf(user), sentinelViewer: !!user.sentinelViewer, ...(user.guest ? { guest: true } : {}), workspace, workspaceCount: docs.length };
    const ent = await entitlements.getEntitlements(ctx, current);
    const works = !user.guest && (entitlements.operatorAccount(ctx) || workspaceService.canWorkIn(workspace));
    const guestSession = user.guest && (sessionId || req?.sessionId) ? await Session.findById(sessionId || req.sessionId).select('expiresAt').lean() : null;
    const mode = workspaceService.mode();
    const demo = await require('../services/demoView').demoAccessOf(user);
    return {
        ...base,
        ...sentinelUi.accessFor(ctx),
        // The shared guest account: read-only, its session ends at guestUntil
        ...(user.guest ? { guest: true, guestUntil: guestSession?.expiresAt || null } : {}),
        // Read-only demo cameras this account sees (services/demoView.js)
        demoView: { cameras: demo.serials.length, simulated: !!demo.orgId, live: demo.live },
        // Simulated demo cameras among those this person sees: the app shows a banner
        simulatedData: !!(await Camera.exists({ simulated: true, ...require('../utils/ownership').viewFilter({ ...ctx, demoSerials: demo.serials, demoOrgId: demo.orgId }) })),
        appMode: mode,
        workspace,
        workspaceCount: docs.length,
        plan: { code: ent.plan, name: ent.planName, expired: !!ent.expired, expiresAt: ent.expiresAt || null },
        capabilities: {
            addCameras: works,
            // The guest account too: reports of its own session (services/guestAccess.js)
            buildDashboards: works || !!user.guest,
            createFarms: works,
            claimCameras: works,
            integrations: works && !!ent.features.apiAndWebhooks,
            pdfReports: !!ent.features.pdfReports,
            telegram: !!ent.features.telegram,
            // b2c / hybrid: the pricing page and upgrade requests; b2b: the organization's owner asks the admin
            pricing: !user.guest && mode !== 'b2b',
            upgradeRequests: !user.guest && (!!workspace || mode !== 'b2b'),
            requestOrganization: !user.guest && mode === 'hybrid'
        }
    };
}

async function sendVerificationEmail(user) {
    const raw = await createToken(user._id, 'email_verify', EMAIL_VERIFY_TTL_HOURS * 60 * 60 * 1000);
    queueMail(emailTemplates.verifyEmailEmail({
        user,
        language: normalizeLanguage(user.language),
        url: appUrl('/auth/verify-email', { token: raw }),
        hours: EMAIL_VERIFY_TTL_HOURS
    }));
}

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

function validNotificationPrefs(prefs) {
    if (typeof prefs !== 'object' || prefs === null) return false;
    for (const key of ['email', 'telegram', 'weeklyReport', 'morningBrief', 'vietgapMonthly', 'orgDigest']) {
        if (prefs[key] !== undefined && typeof prefs[key] !== 'boolean') return false;
    }
    const q = prefs.quietHours;
    if (q !== undefined) {
        if (typeof q !== 'object' || q === null) return false;
        if (q.enabled !== undefined && typeof q.enabled !== 'boolean') return false;
        if (q.start !== undefined && !TIME_REGEX.test(q.start)) return false;
        if (q.end !== undefined && !TIME_REGEX.test(q.end)) return false;
    }
    const muted = prefs.mutedCameras;
    if (muted !== undefined && (!Array.isArray(muted) || muted.length > 500 || muted.some(m => typeof m !== 'string' || m.length > 40))) return false;
    return true;
}

/**
 * User Registration
 */
async function register(req, res) {
    const email = readEmail(req.body);
    const workspaceService = require('../services/workspaceService');
    if (workspaceService.mode() === 'b2b') {
        // Organizations only: sign-up by invitation (an organization added this email), unless ALLOW_SIGNUP
        const { ALLOW_SIGNUP } = require('../config/env');
        const invited = EMAIL_REGEX.test(email) && await Organization.exists({ members: { $elemMatch: { email, userId: null } } });
        if (!ALLOW_SIGNUP && !invited) {
            return res.status(403).json({ success: false, code: 'INVITE_ONLY', message: "Sign-up is by invitation only." });
        }
    } else {
        // Admins control self sign-up in Settings > System (env ALLOW_REGISTRATION is the default)
        const { getSettings } = require('../services/settingsService');
        if (!(await getSettings()).allowRegistration) {
            return res.status(403).json({ success: false, message: "Registration is disabled." });
        }
    }

    const { password } = req.body;
    if (!EMAIL_REGEX.test(email) || email.length > 254) {
        return res.status(400).json({ success: false, message: "Please enter a valid email address." });
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
        return res.status(400).json({ success: false, message: passwordError });
    }

    try {
        const existing = await findByEmail(email);
        if (existing) {
            return res.status(400).json({ success: false, message: "Email already exists." });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        // The very first account administers the system; everyone else starts as a viewer
        const isFirstAccount = (await User.countDocuments({})) === 0;
        const newUser = new User({
            email,
            password: hashedPassword,
            language: normalizeLanguage(req.body.language),
            role: isFirstAccount ? 'admin' : 'user'
        });
        await newUser.save();
        // b2c / hybrid: the personal workspace on the FREE plan
        await workspaceService.ensurePersonal(newUser).catch(err => console.warn('⚠️ Personal workspace not created:', err.message));
        recordAudit(req, {
            action: 'auth.register',
            actor: { id: newUser._id, email: newUser.email },
            target: { type: 'user', id: String(newUser._id), label: newUser.email },
            details: { role: newUser.role }
        });

        // A mail/config problem must not block sign-up; the user can resend from the app
        try {
            await sendVerificationEmail(newUser);
        } catch (mailErr) {
            console.error('⚠️ Could not send verification email:', mailErr.message);
        }

        res.json({ success: true, message: "Registration successful." });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ success: false, message: "Email already exists." });
        }
        sendServerError(res, err, { context: 'Register' });
    }
}

/**
 * POST /api/auth/guest: a session of the shared, read-only guest account (services/guestAccess.js),
 * while Admin > System > Demo access turns guest access on. Rate limited per address and in total.
 */
async function guestLogin(req, res) {
    try {
        const { getSettings } = require('../services/settingsService');
        if (!(await getSettings()).guestAccessEnabled) {
            return res.status(403).json({ success: false, code: 'GUEST_ACCESS_OFF', message: 'Guest access is turned off.' });
        }
        const guestAccess = require('../services/guestAccess');
        const user = await guestAccess.guestUser();
        // The simulated farm's sample reports, shared with the guest (at most every 10 minutes)
        await require('../services/demoSim').ensureReports().catch(err => console.warn(`⚠️ Demo reports: ${err.message}`));
        const sessionId = await createSession(user._id, req, { ttlMs: guestAccess.GUEST_SESSION_MS });
        const token = signToken(user, sessionId);
        setAuthCookie(res, token);
        recordAudit(req, { action: 'auth.guest_login', actor: { id: user._id, email: user.email } });
        res.json({ success: true, token, user: await publicUser(user, req, { sessionId }) });
    } catch (err) {
        sendServerError(res, err, { context: 'Guest access' });
    }
}

/**
 * User Login
 */
async function login(req, res) {
    const email = readEmail(req.body);
    const { password } = req.body;
    if (!email || typeof password !== 'string' || !password) {
        return res.status(400).json({ success: false, message: "Email and password are required." });
    }

    try {
        const user = await findByEmail(email);
        // Same message for unknown email and wrong password so accounts can't be enumerated
        const isMatch = await bcrypt.compare(password, user ? user.password : DUMMY_PASSWORD_HASH) && !!user;
        if (!isMatch) {
            recordAudit(req, {
                action: 'auth.login_failed',
                actor: { id: user?._id, email },
                details: { reason: user ? 'wrong_password' : 'unknown_account' }
            });
            return res.status(401).json({ success: false, message: "Invalid email or password." });
        }
        if (user.disabled) {
            recordAudit(req, { action: 'auth.login_failed', actor: { id: user._id, email: user.email }, details: { reason: 'disabled' } });
            return res.status(403).json({ success: false, code: 'ACCOUNT_DISABLED', message: "This account has been disabled. Contact your administrator." });
        }

        // Remember the UI language so emails match it
        if (SUPPORTED_LANGUAGES.includes(req.body.language) && user.language !== req.body.language) {
            user.language = req.body.language;
            await user.save();
        }

        const sessionId = await createSession(user._id, req);
        const token = signToken(user, sessionId);
        setAuthCookie(res, token);
        recordAudit(req, { action: 'auth.login', actor: { id: user._id, email: user.email } });

        res.json({
            success: true,
            token,
            user: await publicUser(user, req)
        });
    } catch (err) {
        sendServerError(res, err, { context: 'Login' });
    }
}

/**
 * Refresh the httpOnly image cookie from a valid Bearer token
 * (for sessions that logged in before the cookie existed).
 */
async function refreshSession(req, res) {
    setAuthCookie(res, req.authToken);
    res.json({ success: true });
}

/**
 * GET /api/auth/config: public settings the sign-in page needs
 */
async function getAuthConfig(req, res) {
    try {
        const { getSettings } = require('../services/settingsService');
        const contactEmail = (require('../config/env').CONTACT_EMAIL || '').split(',')[0].trim() || null;
        // demoView: new accounts see read-only demo cameras (services/demoView.js)
        const demoView = await require('../services/demoView').isOffered();
        const settings = await getSettings();
        // guestAccess: the sign-in page shows the Guest access button (services/guestAccess.js)
        res.json({ success: true, allowRegistration: settings.allowRegistration, contactEmail, demoView, guestAccess: !!settings.guestAccessEnabled });
    } catch (err) {
        sendServerError(res, err, { context: 'Auth config' });
    }
}

/**
 * GET /api/auth/export: everything this person owns as one ZIP (CSV tables and JSON),
 * streamed as it is read
 */
async function exportMyData(req, res) {
    try {
        const user = await User.findById(req.user.id).lean();
        if (!user) return res.status(404).json({ success: false, message: "User not found" });
        const day = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="FlyBot_data_${day}.zip"`);
        res.setHeader('Cache-Control', 'no-store');
        await dataExportService.writeExport(user, res);
        res.end();
        recordAudit(req, { action: 'auth.data_exported' });
    } catch (err) {
        // Part of the file may already be on its way: cut it so it is not taken for a whole one
        if (res.headersSent) {
            console.error('Data export failed:', err.message);
            return res.destroy(err);
        }
        sendServerError(res, err, { context: 'Export my data' });
    }
}

/**
 * Current user (refreshes emailVerified etc. in the client)
 */
async function getMe(req, res) {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        res.json({ success: true, user: await publicUser(user, req) });
    } catch (err) {
        sendServerError(res, err, { context: 'Get profile' });
    }
}

/**
 * Logout: clear the auth cookie
 */
async function logout(req, res) {
    try {
        const token = readToken(req);
        const resolved = token ? await resolveToken(token) : null;
        if (resolved?.sessionId) {
            await Session.updateOne({ _id: resolved.sessionId, revokedAt: null }, { $set: { revokedAt: new Date() } });
            // A guest's reports end with its session
            if (resolved.user.guest) await require('../models').Dashboard.deleteMany({ ownerId: resolved.user._id, guestSession: String(resolved.sessionId) });
        }
    } catch (err) {
        console.warn('⚠️ Logout session revoke failed:', err.message);
    }
    clearAuthCookie(res);
    res.json({ success: true });
}

/**
 * GET /api/auth/sessions: signed-in devices of the current user
 */
async function listSessions(req, res) {
    try {
        const sessions = await Session.find({ userId: req.user.id, revokedAt: null, expiresAt: { $gt: new Date() } })
            .sort({ lastSeenAt: -1 });
        res.json({
            success: true,
            sessions: sessions.map(sess => ({
                id: sess._id,
                browser: sess.browser,
                os: sess.os,
                ip: sess.ip,
                createdAt: sess.createdAt,
                lastSeenAt: sess.lastSeenAt,
                current: String(sess._id) === String(req.sessionId)
            })),
            // Signed in with a token from before session tracking: it cannot be listed
            currentUntracked: !req.sessionId
        });
    } catch (err) {
        sendServerError(res, err, { context: 'List sessions' });
    }
}

/**
 * DELETE /api/auth/sessions/:sessionId: sign out one device
 */
async function revokeSession(req, res) {
    try {
        const { sessionId } = req.params;
        if (!mongoose.isValidObjectId(sessionId)) {
            return res.status(404).json({ success: false, message: "Session not found." });
        }
        const revoked = await Session.findOneAndUpdate(
            { _id: sessionId, userId: req.user.id, revokedAt: null },
            { $set: { revokedAt: new Date() } }
        );
        if (!revoked) return res.status(404).json({ success: false, message: "Session not found." });
        const isCurrent = String(sessionId) === String(req.sessionId);
        if (isCurrent) clearAuthCookie(res);
        res.json({ success: true, signedOut: isCurrent });
    } catch (err) {
        sendServerError(res, err, { context: 'Revoke session' });
    }
}

/**
 * POST /api/auth/sessions/revoke-others: sign out every other device (including
 * pre-session tokens, via tokenVersion) and return a fresh token for this one.
 */
async function revokeOtherSessions(req, res) {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ success: false, message: "User not found." });

        const filter = { userId: user._id, revokedAt: null };
        if (req.sessionId) filter._id = { $ne: req.sessionId };
        await Session.updateMany(filter, { $set: { revokedAt: new Date() } });

        user.tokenVersion = (user.tokenVersion || 0) + 1;
        await user.save();

        // Legacy token without a session: give this device a tracked session from now on
        const sessionId = req.sessionId || await createSession(user._id, req);
        const token = signToken(user, sessionId);
        setAuthCookie(res, token);
        recordAudit(req, { action: 'auth.sessions_revoked' });
        res.json({ success: true, token });
    } catch (err) {
        sendServerError(res, err, { context: 'Revoke other sessions' });
    }
}

/**
 * Forgot password: always answers the same way, whether or not the account exists,
 * and does the lookup/email after responding so timing does not reveal it either.
 */
async function forgotPassword(req, res) {
    const email = readEmail(req.body);
    if (!EMAIL_REGEX.test(email) || email.length > 254) {
        return res.status(400).json({ success: false, message: "Please enter a valid email address." });
    }
    const requestLanguage = req.body.language;

    res.json({
        success: true,
        message: "If an account exists for this email, a password reset link has been sent."
    });

    setImmediate(async () => {
        try {
            const user = await findByEmail(email);
            if (!user) return;
            const raw = await createToken(user._id, 'password_reset', PASSWORD_RESET_TTL_MINUTES * 60 * 1000);
            queueMail(emailTemplates.passwordResetEmail({
                user,
                language: normalizeLanguage(SUPPORTED_LANGUAGES.includes(requestLanguage) ? requestLanguage : user.language),
                url: appUrl('/auth/reset-password', { token: raw }),
                minutes: PASSWORD_RESET_TTL_MINUTES
            }));
        } catch (err) {
            console.error('⚠️ Forgot password processing failed:', err);
        }
    });
}

/**
 * Reset password with a one-time token; signs out every existing session.
 */
async function resetPassword(req, res) {
    const { token, password } = req.body;
    const passwordError = validatePassword(password);
    if (passwordError) {
        return res.status(400).json({ success: false, message: passwordError });
    }

    try {
        const record = await consumeToken(token, 'password_reset');
        const user = record && await User.findById(record.userId);
        if (!user) {
            return res.status(400).json({ success: false, code: 'INVALID_TOKEN', message: "This reset link is invalid or has expired." });
        }

        user.password = await bcrypt.hash(password, 10);
        user.tokenVersion = (user.tokenVersion || 0) + 1;
        // Receiving the reset email proves ownership of the address
        user.emailVerified = true;
        await user.save();
        await Session.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
        await claimPendingShares(user);

        clearAuthCookie(res);
        queueMail(emailTemplates.passwordChangedEmail({ user, language: normalizeLanguage(user.language) }));
        recordAudit(req, { action: 'auth.password_reset', actor: { id: user._id, email: user.email } });

        res.json({ success: true, message: "Password has been reset. Please sign in." });
    } catch (err) {
        sendServerError(res, err, { context: 'Reset password' });
    }
}

/**
 * Confirm an email address from the verification link
 */
async function verifyEmail(req, res) {
    try {
        const record = await consumeToken(req.body.token, 'email_verify');
        const user = record && await User.findById(record.userId);
        if (!user) {
            return res.status(400).json({ success: false, code: 'INVALID_TOKEN', message: "This verification link is invalid or has expired." });
        }
        user.emailVerified = true;
        await user.save();
        // Invitations sent to this address become real access once it is confirmed
        await claimPendingShares(user);
        res.json({ success: true, message: "Email verified." });
    } catch (err) {
        sendServerError(res, err, { context: 'Verify email' });
    }
}

/**
 * Send a new verification email to the signed-in user
 */
async function resendVerification(req, res) {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        if (user.emailVerified) {
            return res.json({ success: true, alreadyVerified: true, message: "Email is already verified." });
        }
        await sendVerificationEmail(user);
        res.json({ success: true, message: "Verification email sent." });
    } catch (err) {
        sendServerError(res, err, { context: 'Resend verification' });
    }
}

/**
 * Change Password: signs out other sessions and returns a fresh token for this one.
 */
async function changePassword(req, res) {
    const userId = req.user.id;
    const { currentPassword, newPassword } = req.body;
    try {
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, message: "Missing required password change fields." });
        }
        const passwordError = validatePassword(newPassword);
        if (passwordError) {
            return res.status(400).json({ success: false, message: passwordError });
        }
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }
        const isMatch = await bcrypt.compare(String(currentPassword), user.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: "Current password is incorrect." });
        }
        user.password = await bcrypt.hash(newPassword, 10);
        user.tokenVersion = (user.tokenVersion || 0) + 1;
        await user.save();

        const others = { userId: user._id, revokedAt: null };
        if (req.sessionId) others._id = { $ne: req.sessionId };
        await Session.updateMany(others, { $set: { revokedAt: new Date() } });
        const sessionId = req.sessionId || await createSession(user._id, req);
        const token = signToken(user, sessionId);
        setAuthCookie(res, token);
        queueMail(emailTemplates.passwordChangedEmail({ user, language: normalizeLanguage(user.language) }));
        recordAudit(req, { action: 'auth.password_changed' });

        res.json({ success: true, message: "Password changed successfully!", token });
    } catch (err) {
        sendServerError(res, err, { context: 'Change password' });
    }
}

/**
 * Update Profile Information, language and notification preferences
 */
async function updateProfile(req, res) {
    const userId = req.user.id;
    // The avatar has its own upload (POST /api/auth/avatar)
    const { name, language, notificationPrefs } = req.body;
    try {
        if (typeof name !== 'undefined' && (typeof name !== 'string' || name.length > 100)) {
            return res.status(400).json({ success: false, message: "Invalid name." });
        }
        if (typeof language !== 'undefined' && !SUPPORTED_LANGUAGES.includes(language)) {
            return res.status(400).json({ success: false, message: "Invalid language." });
        }
        if (typeof notificationPrefs !== 'undefined' && !validNotificationPrefs(notificationPrefs)) {
            return res.status(400).json({ success: false, message: "Invalid notification preferences." });
        }
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }
        if (typeof name !== 'undefined') user.name = name.trim();
        if (typeof language !== 'undefined') user.language = language;
        if (typeof notificationPrefs?.email === 'boolean') user.set('notificationPrefs.email', notificationPrefs.email);
        if (typeof notificationPrefs?.telegram === 'boolean') user.set('notificationPrefs.telegram', notificationPrefs.telegram);
        if (typeof notificationPrefs?.weeklyReport === 'boolean') user.set('notificationPrefs.weeklyReport', notificationPrefs.weeklyReport);
        if (typeof notificationPrefs?.morningBrief === 'boolean') user.set('notificationPrefs.morningBrief', notificationPrefs.morningBrief);
        if (typeof notificationPrefs?.vietgapMonthly === 'boolean') user.set('notificationPrefs.vietgapMonthly', notificationPrefs.vietgapMonthly);
        if (typeof notificationPrefs?.orgDigest === 'boolean') user.set('notificationPrefs.orgDigest', notificationPrefs.orgDigest);
        if (notificationPrefs?.quietHours) {
            for (const key of ['enabled', 'start', 'end']) {
                if (notificationPrefs.quietHours[key] !== undefined) user.set(`notificationPrefs.quietHours.${key}`, notificationPrefs.quietHours[key]);
            }
        }
        if (Array.isArray(notificationPrefs?.mutedCameras)) user.set('notificationPrefs.mutedCameras', [...new Set(notificationPrefs.mutedCameras)]);
        await user.save();
        res.json({
            success: true,
            message: "Profile updated successfully!",
            user: await publicUser(user, req)
        });
    } catch (err) {
        sendServerError(res, err, { context: 'Update profile' });
    }
}

/**
 * POST /api/auth/avatar (body: the JPEG, at most 2 MB). The browser crops and shrinks the picture
 * first; the server checks it and stores a clean copy.
 */
async function uploadAvatar(req, res) {
    try {
        const { buffer, error } = avatarService.cleanImage(req.body);
        if (error) return res.status(400).json({ success: false, message: error });
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        await avatarService.saveAvatar(user, buffer);
        res.json({ success: true, user: await publicUser(user, req) });
    } catch (err) {
        sendServerError(res, err, { context: 'Upload avatar' });
    }
}

/**
 * DELETE /api/auth/avatar
 */
async function deleteAvatar(req, res) {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        await avatarService.removeAvatar(user);
        res.json({ success: true, user: await publicUser(user, req) });
    } catch (err) {
        sendServerError(res, err, { context: 'Delete avatar' });
    }
}

/**
 * GET /api/auth/avatar: the signed-in user's own picture
 */
async function getAvatar(req, res) {
    try {
        const user = await User.findById(req.user.id).select('avatar').lean();
        const key = avatarService.avatarKeyOf(user);
        if (!key) return res.status(404).json({ success: false, message: "File not found" });
        // The URL changes with every upload (?v=), so the browser may keep it
        return pipeSnapshot(res, key, { cacheControl: 'private, max-age=604800, immutable' });
    } catch (err) {
        sendServerError(res, err, { context: 'Get avatar' });
    }
}

/**
 * GET /api/auth/avatars/:userId: someone else's picture, for people who see them in a member or
 * share list (same 404 otherwise, so accounts cannot be probed)
 */
async function getUserAvatar(req, res) {
    try {
        const { userId } = req.params;
        const notFound = () => res.status(404).json({ success: false, message: "File not found" });
        if (!mongoose.isValidObjectId(userId)) return notFound();
        const user = await User.findById(userId).select('avatar').lean();
        const key = avatarService.avatarKeyOf(user);
        if (!key || !(await avatarService.canSeeAvatar(req.user, userId))) return notFound();
        return pipeSnapshot(res, key, { cacheControl: 'private, max-age=604800, immutable' });
    } catch (err) {
        sendServerError(res, err, { context: 'Get user avatar' });
    }
}

module.exports = {
    guestLogin,
    exportMyData,
    register,
    login,
    refreshSession,
    getAuthConfig,
    getMe,
    logout,
    listSessions,
    revokeSession,
    revokeOtherSessions,
    forgotPassword,
    resetPassword,
    verifyEmail,
    resendVerification,
    changePassword,
    updateProfile,
    sendVerificationEmail,
    uploadAvatar,
    deleteAvatar,
    getAvatar,
    getUserAvatar
};
