const mongoose = require('mongoose');
const config = require('../src/config/env');
const { User } = require('../src/models');
const bcrypt = require('bcryptjs');

// Usage: node scripts/check_password.js <email> <password> [--reset]
// Checks whether <password> matches the stored hash; with --reset, sets it as the new password.
async function testPassword() {
  const [email, password, flag] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: node scripts/check_password.js <email> <password> [--reset]');
    process.exit(1);
  }

  await mongoose.connect(config.MONGO_URI);
  const user = await User.findOne({ email });
  if (!user) {
    console.log('User not found:', email);
    await mongoose.disconnect();
    return;
  }

  const isMatch = await bcrypt.compare(password, user.password);
  console.log('Password match test:', isMatch);
  if (!isMatch && flag === '--reset') {
    user.password = await bcrypt.hash(password, 10);
    await user.save();
    console.log('Password updated successfully!');
  }
  await mongoose.disconnect();
}
testPassword().catch(console.error);
