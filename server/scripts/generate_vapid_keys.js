/**
 * Create the key pair for web push. Run once and put the output in the root .env:
 *   node scripts/generate_vapid_keys.js
 * Keep the same keys afterwards: new keys make every existing device subscription invalid.
 */
const webpush = require('web-push');

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('VAPID_SUBJECT=mailto:admin@your-domain.com');
