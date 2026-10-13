const jwt = require('jsonwebtoken');
const { User, Session } = require('../models');
const { JWT_SECRET, AUTH_COOKIE_NAME, COOKIE_SECURE } = require('../config/env');
const { parseCookies } = require('../utils/http');
const { roleOf } = require('../constants/roles');

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Write lastSeenAt at most this often per session
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

function readToken(req) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.substring(7).trim();
    return parseCookies(req.headers.cookie)[AUTH_COOKIE_NAME] || null;
}

/**
 * Verify a token and return { user, sessionId } or null.
 * Tokens issued before sessions existed have no "sid" and are accepted until they expire.
 */
async function resolveToken(token) {
    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET);
    } catch {
        return null;
    }

    const user = await User.findById(decoded.id).select('-password');
    if (!user || user.disabled) return null;
    // Tokens issued before a password reset/change carry an older version and are rejected
    if ((decoded.v || 0) !== (user.tokenVersion || 0)) return null;

    if (decoded.sid) {
        const session = await Session.findById(decoded.sid);
        if (!session || session.revokedAt || String(session.userId) !== String(user._id)) return null;
        if (Date.now() - new Date(session.lastSeenAt).getTime() > LAST_SEEN_THROTTLE_MS) {
            Session.updateOne({ _id: session._id }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
        }
    }
    return { user, sessionId: decoded.sid || null };
}

/**
 * Authentication Middleware
 * Accepts a JWT from the Authorization: Bearer header (API calls) or from the
 * httpOnly auth cookie (needed by <img> tags, which cannot send headers).
 * Tokens are never accepted from the query string, since URLs end up in logs.
 */
async function authenticate(req, res, next) {
    try {
        const token = readToken(req);
        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required: Missing or invalid Bearer token.'
            });
        }

        const resolved = await resolveToken(token);
        if (!resolved) {
            return res.status(401).json({ success: false, message: 'Session has expired. Please log in again.' });
        }

        const { user, sessionId } = resolved;
        req.user = {
            id: user._id.toString(),
            email: user.email,
            name: user.name || user.email.split('@')[0],
            emailVerified: !!user.emailVerified,
            language: user.language,
            role: roleOf(user)
        };
        req.sessionId = sessionId;
        req.authToken = token;
        return next();
    } catch (error) {
        console.error('⚠️ Authentication error:', error);
        return res.status(500).json({ success: false, message: 'Authentication error.' });
    }
}

function signToken(user, sessionId = null) {
    return jwt.sign(
        { id: user._id.toString(), email: user.email, v: user.tokenVersion || 0, ...(sessionId ? { sid: String(sessionId) } : {}) },
        JWT_SECRET,
        { expiresIn: '7d' }
    );
}

// Simple device label from the User-Agent (no third-party parser needed for a list view)
function describeDevice(userAgent = '') {
    const ua = String(userAgent);
    const browser =
        /Edg\//.test(ua) ? 'Edge'
        : /OPR\/|Opera/.test(ua) ? 'Opera'
        : /Chrome\//.test(ua) ? 'Chrome'
        : /Firefox\//.test(ua) ? 'Firefox'
        : /Safari\//.test(ua) ? 'Safari'
        : 'Other';
    const os =
        /Windows/.test(ua) ? 'Windows'
        : /Android/.test(ua) ? 'Android'
        : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
        : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
        : /Linux/.test(ua) ? 'Linux'
        : 'Other';
    return { browser, os };
}

/**
 * Record a new signed-in device and return its id.
 */
async function createSession(userId, req) {
    const { browser, os } = describeDevice(req.headers['user-agent']);
    const session = await Session.create({
        userId,
        browser,
        os,
        ip: String(req.ip || '').slice(0, 64),
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS)
    });
    return session._id;
}

function setAuthCookie(res, token) {
    res.cookie(AUTH_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: COOKIE_SECURE,
        maxAge: TOKEN_TTL_MS,
        path: '/api'
    });
}

function clearAuthCookie(res) {
    res.clearCookie(AUTH_COOKIE_NAME, {
        httpOnly: true,
        sameSite: 'lax',
        secure: COOKIE_SECURE,
        path: '/api'
    });
}

/**
 * Allow only the given roles (use after authenticate).
 */
function requireRole(...roles) {
    return (req, res, next) => {
        if (roles.includes(req.user?.role)) return next();
        return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'You do not have permission to do this.' });
    };
}

module.exports = {
    authenticate,
    requireRole,
    readToken,
    resolveToken,
    signToken,
    createSession,
    describeDevice,
    setAuthCookie,
    clearAuthCookie
};
