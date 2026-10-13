const mongoose = require('mongoose');
const config = require('../src/config/env');
const { Camera, Snapshot, User } = require('../src/models');

async function test() {
  await mongoose.connect(config.MONGO_URI);
  console.log('Connected to DB');
  const userCount = await User.countDocuments();
  const camCount = await Camera.countDocuments();
  const snapCount = await Snapshot.countDocuments();
  const processedSnapCount = await Snapshot.countDocuments({ aiProcessed: true });
  console.log({ userCount, camCount, snapCount, processedSnapCount });
  
  const cams = await Camera.find().select('deviceSerial deviceName locationAddress status');
  console.log('Cameras:', cams);

  const sampleSnaps = await Snapshot.find({ aiProcessed: true }).sort({ createdAt: -1 }).limit(10);
  console.log('Latest 10 Snaps:', JSON.stringify(sampleSnaps.map(s => ({
    id: s._id,
    serial: s.deviceSerial,
    date: s.createdAt,
    summary: s.aiResults?.summary,
    insectsCount: s.aiResults?.insects?.length,
    rawDesc: s.aiResults?.raw_description
  })), null, 2));

  // Check all distinct summary keys in snapshots
  const summaryKeys = await Snapshot.aggregate([
    { $match: { aiProcessed: true } },
    { $project: { keys: { $map: { input: { $objectToArray: '$aiResults.summary' }, as: 'kv', in: '$$kv.k' } } } },
    { $unwind: '$keys' },
    { $group: { _id: '$keys', count: { $sum: 1 } } }
  ]);
  console.log('Summary keys in DB:', summaryKeys);

  await mongoose.disconnect();
}
test().catch(console.error);
