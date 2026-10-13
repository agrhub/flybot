const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Define source and destination directories
const clientDir = path.resolve(__dirname, '../../client');
const clientDist = path.resolve(clientDir, 'dist');
const serverDist = path.resolve(__dirname, '../dist');

// Check if client/dist exists; if not, build client first
if (!fs.existsSync(clientDist) || !fs.existsSync(path.join(clientDist, 'index.html'))) {
    console.log('📦 Client build output not found. Building client first...');
    try {
        execSync('npm run build', { cwd: clientDir, stdio: 'inherit' });
    } catch (error) {
        console.error('❌ Failed to build client:', error.message);
        process.exit(1);
    }
}

// Ensure server/dist directory exists
if (!fs.existsSync(serverDist)) {
    fs.mkdirSync(serverDist, { recursive: true });
}

console.log(`📋 Copying client assets from: ${clientDist}`);
console.log(`                       into: ${serverDist}`);

try {
    // Copy all assets recursively into server/dist without overwriting server dist/app.js
    fs.cpSync(clientDist, serverDist, {
        recursive: true,
        force: true
    });
    console.log('✅ Client assets successfully copied to server/dist');
} catch (error) {
    console.error('❌ Error copying client assets:', error.message);
    process.exit(1);
}
