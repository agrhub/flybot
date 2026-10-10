const mongoose = require('mongoose');
const config = require('../src/config/env');
const { Snapshot } = require('../src/models');

async function testAggregation() {
  await mongoose.connect(config.MONGO_URI);

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 30);

  const matchQuery = {
    aiProcessed: true,
    createdAt: { $gte: startDate }
  };

  const data = await Snapshot.aggregate([
    { $match: matchQuery },
    {
      $project: {
        deviceSerial: 1,
        createdAt: 1,
        dateKey: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Ho_Chi_Minh" } },
        displayKey: { $dateToString: { format: "%d/%m", date: "$createdAt", timezone: "Asia/Ho_Chi_Minh" } },
        summaryArray: { $objectToArray: "$aiResults.summary" }
      }
    },
    { $unwind: "$summaryArray" },
    {
      $addFields: {
        normalizedInsect: {
          $cond: [
            { $in: ["$summaryArray.k", ["fruit_fly", "fruit fly", "fruit-fly", "ruồi vàng", "ruoi vang"]] },
            "ruồi vàng",
            "$summaryArray.k"
          ]
        }
      }
    },
    // Step 1: Max per camera per day per insect
    {
      $group: {
        _id: {
          dateKey: "$dateKey",
          displayKey: "$displayKey",
          camera: "$deviceSerial",
          insect: "$normalizedInsect"
        },
        camMax: { $max: "$summaryArray.v" }
      }
    },
    // Step 2: Sum across cameras for that day
    {
      $group: {
        _id: {
          dateKey: "$_id.dateKey",
          displayKey: "$_id.displayKey",
          insect: "$_id.insect"
        },
        totalCount: { $sum: "$camMax" }
      }
    },
    // Step 3: Group by date
    {
      $group: {
        _id: {
          dateKey: "$_id.dateKey",
          displayKey: "$_id.displayKey"
        },
        insects: {
          $push: {
            label: "$_id.insect",
            value: "$totalCount"
          }
        }
      }
    },
    { $sort: { "_id.dateKey": 1 } },
    {
      $project: {
        _id: "$_id.displayKey",
        dateKey: "$_id.dateKey",
        insects: 1
      }
    }
  ]);

  console.log('Resulting real daily data points:');
  console.log(JSON.stringify(data, null, 2));

  await mongoose.disconnect();
}

testAggregation().catch(console.error);
