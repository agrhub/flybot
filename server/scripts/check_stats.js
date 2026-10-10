const mongoose = require('mongoose');
const config = require('../src/config/env');
const { Snapshot, Camera } = require('../src/models');
const { FRUIT_FLY, FRUIT_FLY_ALIASES } = require('../src/constants/species');

async function test() {
  await mongoose.connect(config.MONGO_URI);
  
  // Check snapshots count and counts per day
  const dailyCounts = await Snapshot.aggregate([
    { $match: { aiProcessed: true } },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Ho_Chi_Minh" } },
        totalSnaps: { $sum: 1 },
        summaryObjs: { $push: "$aiResults.summary" }
      }
    },
    { $sort: { _id: -1 } },
    { $limit: 15 }
  ]);

  console.log('Daily processed snapshots and summaries:');
  dailyCounts.forEach(d => {
    let canonicalSum = 0;
    let legacySum = 0;
    d.summaryObjs.forEach(s => {
      if (!s) return;
      for (const [k, v] of Object.entries(s)) {
        if (k === FRUIT_FLY) canonicalSum += v || 0;
        else if (FRUIT_FLY_ALIASES.includes(k)) legacySum += v || 0;
      }
    });
    console.log(`Date: ${d._id} | Snaps: ${d.totalSnaps} | sum(${FRUIT_FLY}): ${canonicalSum} | sum(legacy aliases): ${legacySum}`);
  });

  // Check some individual snapshots with large counts
  const highCountSnaps = await Snapshot.find({
    aiProcessed: true,
    $or: FRUIT_FLY_ALIASES.map(alias => ({ [`aiResults.summary.${alias}`]: { $gt: 5 } }))
  }).sort({ createdAt: -1 }).limit(10);

  console.log('\nHigh count snapshots in DB:', highCountSnaps.length);
  highCountSnaps.forEach(s => {
    console.log(`ID: ${s._id} | Serial: ${s.deviceSerial} | Created: ${s.createdAt} | Provider: ${s.aiProvider} | Summary:`, JSON.stringify(s.aiResults?.summary), '| RawDesc:', s.aiResults?.raw_description);
  });

  await mongoose.disconnect();
}
test().catch(console.error);
