const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    email: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    name: { type: String, default: '' },
    avatar: { type: String, default: '' },
    emailVerified: { type: Boolean, default: false },
    // UI/email language: 'vi' | 'en'
    language: { type: String, default: 'vi' },
    // Embedded in login tokens; bumping it signs out every existing session
    tokenVersion: { type: Number, default: 0 },
    notificationPrefs: {
        // Alert emails are only sent to verified addresses
        email: { type: Boolean, default: true }
    },
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

module.exports = User;
