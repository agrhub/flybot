const mongoose = require('mongoose');
const config = require('../src/config/env');
const { User, Camera, Snapshot } = require('../src/models');
const bcrypt = require('bcryptjs');

// Usage: node scripts/check_user.js <email>
async function checkUser() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node scripts/check_user.js <email>');
    process.exit(1);
  }
  await mongoose.connect(config.MONGO_URI);
  console.log('Connected to DB');

  const user = await User.findOne({ email });
  console.log('Found user:', user ? { id: user._id, email: user.email, name: user.name } : 'NOT FOUND');

  if (!user) {
    console.log('Listing all existing users:');
    const allUsers = await User.find().select('email name');
    console.log(allUsers);
  } else {
    // Check cameras linked to this user
    const cams = await Camera.find({ userId: user._id });
    console.log(`Cameras linked to user ${user.email}:`, cams.length);
    cams.forEach(c => console.log(`  - ${c.deviceName} (${c.deviceSerial})`));
  }

  await mongoose.disconnect();
}

checkUser().catch(console.error);
