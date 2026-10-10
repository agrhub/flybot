const mongoose = require('mongoose');
const config = require('../src/config/env');
const { FRUIT_FLY, FRUIT_FLY_ALIASES } = require('../src/constants/species');

// Usage: node scripts/normalize_species.js [--apply]
// Rewrites every fruit fly alias in snapshot summaries and insect names to the canonical key.
// Without --apply it only reports what would change.
const LEGACY_ALIASES = FRUIT_FLY_ALIASES.filter(alias => alias !== FRUIT_FLY);

async function migrate() {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(config.MONGO_URI);
  console.log(`Connected to DB (${apply ? 'APPLY' : 'dry run'})`);
  const collection = mongoose.connection.db.collection('snapshots');

  const docs = await collection.find({
    $or: [
      ...LEGACY_ALIASES.map(alias => ({ [`aiResults.summary.${alias}`]: { $exists: true } })),
      { 'aiResults.insects.name': { $in: LEGACY_ALIASES } }
    ]
  }).toArray();

  console.log(`Found ${docs.length} docs with legacy fruit fly labels`);

  let updated = 0;
  for (const doc of docs) {
    const summary = doc.aiResults?.summary || {};
    const insects = doc.aiResults?.insects || [];

    // Merge all aliases into one count (the highest, as older code kept the larger of the two)
    const newSummary = {};
    let fruitFlyCount = 0;
    for (const [k, v] of Object.entries(summary)) {
      if (FRUIT_FLY_ALIASES.includes(k)) {
        fruitFlyCount = Math.max(fruitFlyCount, Number(v) || 0);
      } else {
        newSummary[k] = v;
      }
    }
    if (Object.keys(summary).some(k => FRUIT_FLY_ALIASES.includes(k))) {
      newSummary[FRUIT_FLY] = fruitFlyCount;
    }

    const newInsects = insects.map(ins =>
      FRUIT_FLY_ALIASES.includes(ins.name) ? { ...ins, name: FRUIT_FLY } : ins
    );

    if (apply) {
      await collection.updateOne(
        { _id: doc._id },
        { $set: { 'aiResults.summary': newSummary, 'aiResults.insects': newInsects } }
      );
    }
    updated++;
  }

  console.log(apply ? `Migrated ${updated} docs.` : `Would migrate ${updated} docs. Re-run with --apply to write.`);

  const summaryKeys = await collection.aggregate([
    { $match: { aiProcessed: true } },
    { $project: { keys: { $map: { input: { $objectToArray: '$aiResults.summary' }, as: 'kv', in: '$$kv.k' } } } },
    { $unwind: '$keys' },
    { $group: { _id: '$keys', count: { $sum: 1 } } }
  ]).toArray();

  console.log('Summary keys in DB:', summaryKeys);

  await mongoose.disconnect();
}

migrate().catch(console.error);
