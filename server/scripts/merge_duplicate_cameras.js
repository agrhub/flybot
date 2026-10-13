const mongoose = require('mongoose');
const config = require('../src/config/env');
const { Camera } = require('../src/models');
const { mergeDuplicateCameras } = require('../src/services/migrations');

// Usage: node scripts/merge_duplicate_cameras.js [--apply]
// Merges records of the same camera serial added by several accounts: the earliest stays the
// owner, the others become people it is shared with. Without --apply it only reports.
async function main() {
    const apply = process.argv.includes('--apply');
    await mongoose.connect(config.MONGO_URI);
    console.log(`Connected (${apply ? 'APPLY' : 'preview'})`);

    const result = await mergeDuplicateCameras({ apply });
    for (const d of result.details) {
        console.log(`  ${d.deviceSerial}: owner ${d.ownerId}, ${d.removed} duplicate record(s) -> shared with ${d.sharedWith}`);
    }
    console.log(apply
        ? `Merged ${result.merged} duplicate record(s) in ${result.groups} serial(s).`
        : `Would merge ${result.merged} duplicate record(s) in ${result.groups} serial(s). Re-run with --apply.`);

    if (apply) {
        // Now that serials are unique, build the unique index
        await Camera.syncIndexes();
        console.log('Camera indexes are in sync (deviceSerial is unique).');
    }
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
