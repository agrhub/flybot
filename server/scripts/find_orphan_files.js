// Report photo files in S3 that no snapshot in the database points to. Read-only: nothing is deleted.
// Usage (from server/): node scripts/find_orphan_files.js [--out orphans.txt] [--min-age-hours 1]
// Uses MONGO_URI and the S3 settings from .env.
const fs = require('fs');
const mongoose = require('mongoose');
const { MONGO_URI } = require('../src/config/env');
const { findOrphanFiles } = require('../src/services/orphanFiles');

const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
};
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

(async () => {
    const out = arg('--out');
    const minAgeHours = Number(arg('--min-age-hours') || 1);
    await mongoose.connect(MONGO_URI);
    try {
        const result = await findOrphanFiles({
            minAgeMs: minAgeHours * 60 * 60 * 1000,
            onCamera: (serial, r) => process.stdout.write(`\r${serial}: ${r.scanned} file(s) checked, ${r.orphans.length} orphan(s)   `)
        });
        console.log(`\n\nChecked ${result.scanned} file(s): ${result.orphans.length} with no snapshot (${mb(result.bytes)}).`);
        for (const [serial, n] of Object.entries(result.byCamera).sort((a, b) => b[1] - a[1])) console.log(`  ${serial}: ${n}`);
        if (out) {
            fs.writeFileSync(out, result.orphans.map(o => o.key).join('\n') + (result.orphans.length ? '\n' : ''));
            console.log(`Keys written to ${out}`);
        } else if (result.orphans.length) {
            console.log('Use --out <file> to list their keys.');
        }
    } finally {
        await mongoose.disconnect();
    }
})().catch((err) => {
    console.error('❌', err.message);
    process.exit(1);
});
