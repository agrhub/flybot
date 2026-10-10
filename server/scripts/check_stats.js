const mongoose = require('mongoose');
const config = require('../src/config/env');
const { Snapshot, Camera } = require('../src/models');

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
    let ruoiVangSum = 0;
    let fruitFlySum = 0;
    d.summaryObjs.forEach(s => {
      if (s) {
        ruoiVangSum += (s['ruồi vàng'] || 0);
        fruitFlySum += (s['fruit_fly'] || 0);
      }
    });
    console.log(`Date: ${d._id} | Snaps: ${d.totalSnaps} | sum(ruồi vàng): ${ruoiVangSum} | sum(fruit_fly): ${fruitFlySum}`);
  });

  // Check some individual snapshots with large counts
  const highCountSnaps = await Snapshot.find({
    aiProcessed: true,
    $or: [
      { 'aiResults.summary.ruồi vàng': { $gt: 5 } },
      { 'aiResults.summary.fruit_fly': { $gt: 5 } }
    ]
  }).sort({ createdAt: -1 }).limit(10);

  console.log('\nHigh count snapshots in DB:', highCountSnaps.length);
  highCountSnaps.forEach(s => {
    console.log(`ID: ${s._id} | Serial: ${s.deviceSerial} | Created: ${s.createdAt} | Provider: ${s.aiProvider} | Summary:`, JSON.stringify(s.aiResults?.summary), '| RawDesc:', s.aiResults?.raw_description);
  });

  await mongoose.disconnect();
}
test().catch(console.error);
