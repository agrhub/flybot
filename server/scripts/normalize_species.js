const mongoose = require('mongoose');
const config = require('../src/config/env');

async function migrate() {
  await mongoose.connect(config.MONGO_URI);
  console.log('Connected to DB for migration');
  const collection = mongoose.connection.db.collection('snapshots');

  // Find documents where aiResults.summary.fruit_fly exists
  const docs = await collection.find({
    $or: [
      { 'aiResults.summary.fruit_fly': { $exists: true } },
      { 'aiResults.summary.fruit fly': { $exists: true } },
      { 'aiResults.insects.name': { $in: ['fruit_fly', 'fruit fly', 'fruit-fly'] } }
    ]
  }).toArray();

  console.log(`Found ${docs.length} raw docs to normalize`);

  let updated = 0;
  for (const doc of docs) {
    const summary = doc.aiResults?.summary || {};
    const insects = doc.aiResults?.insects || [];

    const ffCount = (summary['fruit_fly'] !== undefined ? summary['fruit_fly'] : (summary['fruit fly'] !== undefined ? summary['fruit fly'] : 0));
    const currentRuoiVang = summary['ruồi vàng'] || 0;
    const finalRuoiVang = currentRuoiVang > 0 ? currentRuoiVang : ffCount;

    const newSummary = {};
    for (const [k, v] of Object.entries(summary)) {
      if (k === 'fruit_fly' || k === 'fruit fly') {
        newSummary['ruồi vàng'] = finalRuoiVang;
      } else {
        newSummary[k] = v;
      }
    }
    if (!newSummary['ruồi vàng'] && ffCount > 0) {
      newSummary['ruồi vàng'] = ffCount;
    }

    const newInsects = insects.map(ins => {
      if (ins.name === 'fruit_fly' || ins.name === 'fruit fly' || ins.name === 'fruit-fly') {
        return { ...ins, name: 'ruồi vàng' };
      }
      return ins;
    });

    await collection.updateOne(
      { _id: doc._id },
      {
        $set: {
          'aiResults.summary': newSummary,
          'aiResults.insects': newInsects
        }
      }
    );
    updated++;
  }

  console.log(`Migrated ${updated} docs!`);

  // Verify
  const summaryKeys = await collection.aggregate([
    { $match: { aiProcessed: true } },
    { $project: { keys: { $map: { input: { $objectToArray: '$aiResults.summary' }, as: 'kv', in: '$$kv.k' } } } },
    { $unwind: '$keys' },
    { $group: { _id: '$keys', count: { $sum: 1 } } }
  ]).toArray();

  console.log('Summary keys in DB after migration:', summaryKeys);

  await mongoose.disconnect();
}

migrate().catch(console.error);
