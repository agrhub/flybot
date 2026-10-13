/**
 * Rebuild the daily statistics (DailyStat) from all snapshots.
 * The server builds them on first start and keeps them current; run this only if they
 * look wrong (for example after restoring snapshots from a backup):
 *   node scripts/rebuild_daily_stats.js
 */
const mongoose = require('mongoose');
const { connectDB } = require('../src/config/db');
const { rebuildAll } = require('../src/services/dailyStats');

(async () => {
    await connectDB();
    await rebuildAll();
    await mongoose.disconnect();
})().catch((err) => {
    console.error('❌ Rebuild failed:', err);
    process.exit(1);
});
