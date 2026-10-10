const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const path = require('path');
const fs = require('fs');

const { PORT, JWT_SECRET, CORS_ORIGINS, TRUST_PROXY } = require('./config/env');
const { connectDB } = require('./config/db');
const routes = require('./routes');
const { syncCameraStatus } = require('./services/ezvizService');
const { autoCaptureAllCameras } = require('./cron/captureJob');
const { startCronJobs } = require('./cron/scheduler');

const app = express();

if (TRUST_PROXY) {
    app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);
}

// Middlewares
// The client is served same-origin (or via the Vite proxy), so cross-origin access is off unless allowlisted
app.use(cors({ origin: CORS_ORIGINS.length > 0 ? CORS_ORIGINS : false, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// API Routes
app.use(routes);

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Locate client build directory
const candidateStaticDirs = [
    path.resolve(__dirname, '.'),                 // Bundled in server/dist
    path.resolve(__dirname, '../dist'),           // Running from server/src
    path.resolve(__dirname, '../../client/dist'), // Fallback to client/dist in dev
    path.resolve(process.cwd(), 'dist'),          // CWD fallback
    path.resolve(process.cwd(), 'server/dist'),   // CWD root fallback
    path.resolve(process.cwd(), 'client/dist'),   // CWD root client fallback
];

const clientStaticDir = candidateStaticDirs.find((dir) => {
    try {
        return fs.existsSync(path.join(dir, 'index.html'));
    } catch {
        return false;
    }
});

if (clientStaticDir) {
    console.log(`📁 Serving client static assets from: ${clientStaticDir}`);

    // Prevent direct access to backend server artifacts
    app.use((req, res, next) => {
        if (req.path === '/app.js' || req.path === '/app.js.map') {
            return res.status(404).send('Not Found');
        }
        next();
    });

    // Serve static files (HTML, JS, CSS, images, etc.)
    app.use(express.static(clientStaticDir));

    // Fallback to index.html for client-side SPA routing (excluding /api and /health)
    app.use((req, res, next) => {
        if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/health')) {
            return res.sendFile(path.join(clientStaticDir, 'index.html'));
        }
        next();
    });
} else {
    console.log('ℹ️ No client static directory found. Client asset serving disabled.');
}

// Error handling middleware (catches bad JSON or route crashes)
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ success: false, message: 'Invalid JSON payload format' });
    }
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ success: false, message: 'Payload too large' });
    }
    console.error('⚠️ Unhandled server error:', err);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
});

// Process safeguards
// After an uncaught exception the process state is undefined, so log and exit;
// run under a process manager (pm2, systemd, Docker restart policy) to restart it.
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception, shutting down:', err);
    process.exit(1);
});

// Rejections are logged but not fatal: background jobs (status sync, capture) fire-and-forget
// and a single failed EZVIZ/S3 call should not take the whole server down.
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Unhandled Rejection:', reason);
});

// Start server and background services
async function startServer() {
    if (!JWT_SECRET || JWT_SECRET.length < 32) {
        console.error('❌ Refusing to start: set JWT_SECRET (at least 32 characters) in your .env file.');
        process.exit(1);
    }

    // 1. Connect to Database
    await connectDB();

    // 2. Start Express HTTP Server
    app.listen(PORT, () => {
        console.log(`🚀 Server is running at http://localhost:${PORT}`);

        // 3. Initial camera status sync & capture
        syncCameraStatus();
        autoCaptureAllCameras();

        // 4. Start periodic cron jobs
        startCronJobs();
    });
}

// Direct execution
if (require.main === module) {
    startServer();
}

module.exports = { app, startServer };
