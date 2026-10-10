const bcrypt = require('bcryptjs');
const { User } = require('../models');
const { ALLOW_REGISTRATION } = require('../config/env');
const { signToken, setAuthCookie, clearAuthCookie } = require('../middlewares/auth');
const { sendServerError } = require('../utils/http');

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

function toPublicUser(user) {
    return {
        id: user._id,
        email: user.email,
        name: user.name || user.email.split('@')[0],
        avatar: user.avatar || ''
    };
}

/**
 * User Registration
 */
async function register(req, res) {
    if (!ALLOW_REGISTRATION) {
        return res.status(403).json({ success: false, message: "Registration is disabled." });
    }

    const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
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
        const newUser = new User({ email, password: hashedPassword });
        await newUser.save();

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
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
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

        const token = signToken(user);
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
 * Logout: clear the auth cookie
 */
async function logout(req, res) {
    clearAuthCookie(res);
    res.json({ success: true });
}

/**
 * Change Password
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
        await user.save();
        res.json({ success: true, message: "Password changed successfully!" });
    } catch (err) {
        sendServerError(res, err, { context: 'Change password' });
    }
}

/**
 * Update Profile Information
 */
async function updateProfile(req, res) {
    const userId = req.user.id;
    const { name, avatar } = req.body;
    try {
        if (typeof name !== 'undefined' && (typeof name !== 'string' || name.length > 100)) {
            return res.status(400).json({ success: false, message: "Invalid name." });
        }
        if (typeof avatar !== 'undefined' && typeof avatar !== 'string') {
            return res.status(400).json({ success: false, message: "Invalid avatar." });
        }
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }
        if (typeof name !== 'undefined') user.name = name.trim();
        if (typeof avatar !== 'undefined') user.avatar = avatar;
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
    logout,
    changePassword,
    updateProfile
};
