const mongoose = require('mongoose');
const { MONGO_URI } = require('./env');

async function connectDB() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log("✅ MongoDB Connected");
    } catch (err) {
        console.error("❌ MongoDB Connection Error:", err);
        process.exit(1);
    }
}

module.exports = { connectDB };
