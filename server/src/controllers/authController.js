const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { User, Session } = require('../models');
const { ALLOW_REGISTRATION } = require('../config/env');
const { signToken, setAuthCookie, clearAuthCookie, createSession, readToken, resolveToken } = require('../middlewares/auth');
const { sendServerError } = require('../utils/http');
const { normalizeLanguage, SUPPORTED_LANGUAGES } = require('../utils/i18n');
const { queueMail } = require('../services/mailService');
const emailTemplates = require('../services/emailTemplates');
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

const readEmail = (body) => (typeof body.email === 'string' ? body.email.trim() : '');

function toPublicUser(user) {
    return {
        id: user._id,
        email: user.email,
        name: user.name || user.email.split('@')[0],
        avatar: user.avatar || '',
        emailVerified: !!user.emailVerified,
        language: normalizeLanguage(user.language),
        notificationPrefs: {
            email: user.notificationPrefs?.email !== false,
            telegram: user.notificationPrefs?.telegram !== false
        },
        telegram: {
            connected: !!user.telegram?.chatId,
            username: user.telegram?.username || ''
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

/**
 * User Registration
 */
async function register(req, res) {
    if (!ALLOW_REGISTRATION) {
        return res.status(403).json({ success: false, message: "Registration is disabled." });
    }

    const email = readEmail(req.body);
    const { password } = req.body;
    if (!EMAIL_REGEX.test(email) || email.length > 254) {
        return res.status(400).json({ success: false, message: "Please enter a valid email address." });
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
        return res.status(400).json({ success: false, message: passwordError });
    }

    try {
        const existing = await User.findOne({ email });
        if (existing) {
            return res.status(400).json({ success: false, message: "Email already exists." });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ email, password: hashedPassword, language: normalizeLanguage(req.body.language) });
        await newUser.save();

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
 * User Login
 */
async function login(req, res) {
    const email = readEmail(req.body);
    const { password } = req.body;
    if (!email || typeof password !== 'string' || !password) {
        return res.status(400).json({ success: false, message: "Email and password are required." });
    }

    try {
        const user = await User.findOne({ email });
        // Same message for unknown email and wrong password so accounts can't be enumerated
        const isMatch = user ? await bcrypt.compare(password, user.password) : false;
        if (!isMatch) {
            return res.status(401).json({ success: false, message: "Invalid email or password." });
        }

        // Remember the UI language so emails match it
        if (SUPPORTED_LANGUAGES.includes(req.body.language) && user.language !== req.body.language) {
            user.language = req.body.language;
            await user.save();
        }

        const sessionId = await createSession(user._id, req);
        const token = signToken(user, sessionId);
        setAuthCookie(res, token);

        res.json({
            success: true,
            token,
            user: toPublicUser(user)
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
 * Current user (refreshes emailVerified etc. in the client)
 */
async function getMe(req, res) {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        res.json({ success: true, user: toPublicUser(user) });
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
            const user = await User.findOne({ email }).collation({ locale: 'en', strength: 2 });
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

        clearAuthCookie(res);
        queueMail(emailTemplates.passwordChangedEmail({ user, language: normalizeLanguage(user.language) }));

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
    const { name, avatar, language, notificationPrefs } = req.body;
    try {
        if (typeof name !== 'undefined' && (typeof name !== 'string' || name.length > 100)) {
            return res.status(400).json({ success: false, message: "Invalid name." });
        }
        if (typeof avatar !== 'undefined' && typeof avatar !== 'string') {
            return res.status(400).json({ success: false, message: "Invalid avatar." });
        }
        if (typeof language !== 'undefined' && !SUPPORTED_LANGUAGES.includes(language)) {
            return res.status(400).json({ success: false, message: "Invalid language." });
        }
        if (typeof notificationPrefs !== 'undefined' &&
            (typeof notificationPrefs !== 'object' || notificationPrefs === null ||
             (notificationPrefs.email !== undefined && typeof notificationPrefs.email !== 'boolean') ||
             (notificationPrefs.telegram !== undefined && typeof notificationPrefs.telegram !== 'boolean'))) {
            return res.status(400).json({ success: false, message: "Invalid notification preferences." });
        }
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }
        if (typeof name !== 'undefined') user.name = name.trim();
        if (typeof avatar !== 'undefined') user.avatar = avatar;
        if (typeof language !== 'undefined') user.language = language;
        if (typeof notificationPrefs?.email === 'boolean') user.set('notificationPrefs.email', notificationPrefs.email);
        if (typeof notificationPrefs?.telegram === 'boolean') user.set('notificationPrefs.telegram', notificationPrefs.telegram);
        await user.save();
        res.json({
            success: true,
            message: "Profile updated successfully!",
            user: toPublicUser(user)
        });
    } catch (err) {
        sendServerError(res, err, { context: 'Update profile' });
    }
}

module.exports = {
    register,
    login,
    refreshSession,
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
    updateProfile
};
