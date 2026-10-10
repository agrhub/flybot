const jwt = require('jsonwebtoken');
const { User } = require('../models');
const { JWT_SECRET, AUTH_COOKIE_NAME, COOKIE_SECURE } = require('../config/env');
const { parseCookies } = require('../utils/http');

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Authentication Middleware
 * Accepts a JWT from the Authorization: Bearer header (API calls) or from the
 * httpOnly auth cookie (needed by <img> tags, which cannot send headers).
 * Tokens are never accepted from the query string, since URLs end up in logs.
 */
async function authenticate(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        let token = null;

        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.substring(7).trim();
        } else {
            token = parseCookies(req.headers.cookie)[AUTH_COOKIE_NAME] || null;
        }

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required: Missing or invalid Bearer token.'
            });
        }

        let decoded;
        try {
            decoded = jwt.verify(token, JWT_SECRET);
        } catch (jwtErr) {
            return res.status(401).json({ success: false, message: 'Session has expired. Please log in again.' });
        }

        const user = await User.findById(decoded.id).select('-password');
        if (!user) {
            return res.status(401).json({ success: false, message: 'User does not exist or has been disabled.' });
        }
        // Tokens issued before a password reset/change carry an older version and are rejected
        if ((decoded.v || 0) !== (user.tokenVersion || 0)) {
            return res.status(401).json({ success: false, message: 'Session has expired. Please log in again.' });
        }
        req.user = {
            id: user._id.toString(),
            email: user.email,
            name: user.name || user.email.split('@')[0],
            emailVerified: !!user.emailVerified,
            language: user.language
        };
        req.authToken = token;
        return next();
    } catch (error) {
        console.error('⚠️ Authentication error:', error);
        return res.status(500).json({ success: false, message: 'Authentication error.' });
    }
}

function signToken(user) {
    return jwt.sign(
        { id: user._id.toString(), email: user.email, v: user.tokenVersion || 0 },
        JWT_SECRET,
        { expiresIn: '7d' }
    );
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

module.exports = {
    authenticate,
    signToken,
    setAuthCookie,
    clearAuthCookie
};
