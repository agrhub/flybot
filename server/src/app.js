const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const path = require('path');
const fs = require('fs');

const mongoose = require('mongoose');
const { PORT, JWT_SECRET, CORS_ORIGINS, TRUST_PROXY, ENABLE_CRON, COOKIE_SECURE } = require('./config/env');
const { connectDB } = require('./config/db');
const { runStartupMigrations } = require('./services/migrations');
const routes = require('./routes');
const { syncCameraStatus } = require('./services/ezvizService');
const { autoCaptureDueCameras, backfillCameraThumbnails } = require('./cron/captureJob');
const telegramService = require('./services/telegramService');
const { startCronJobs } = require('./cron/scheduler');

const app = express();

if (TRUST_PROXY) {
    // "1" = number of proxy hops, "true"/"false" = booleans, anything else = IP/subnet list
    const trustProxy = /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY)
        : TRUST_PROXY === 'true' ? true
        : TRUST_PROXY === 'false' ? false
        : TRUST_PROXY;
    app.set('trust proxy', trustProxy);
}

// Middlewares
// The client is served same-origin (or via the Vite proxy), so cross-origin access is off unless allowlisted
app.use(cors({ origin: CORS_ORIGINS.length > 0 ? CORS_ORIGINS : false, credentials: true }));
// Messages in the app's language (X-Language); first, so error handlers are covered too
app.use(require('./middlewares/localizeMessages').localizeMessages);
app.use(express.json({ limit: '1mb' }));

// Security headers. No full CSP yet: the EZVIZ player, Tailwind CDN, Google Fonts and Maps
// load from several origins; framing and sniffing are still blocked.
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'; base-uri 'self'; object-src 'none'");
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (COOKIE_SECURE) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});
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
        // Decode first: "/%61pp.js" must not slip past the check
        let requested = req.path;
        try {
            requested = decodeURIComponent(req.path);
        } catch {
            return res.status(400).send('Bad Request');
        }
        if (/^\/+app\.js(\.map)?$/i.test(requested)) {
            return res.status(404).send('Not Found');
        }
        next();
    });

    // Serve static files (HTML, JS, CSS, images, etc.)
    app.use(express.static(clientStaticDir, {
        setHeaders(res, filePath) {
            // Browsers must always check for a new service worker / manifest
            if (/[\\/](sw\.js|manifest\.webmanifest)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
            if (filePath.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json');
        }
    }));

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
    await runStartupMigrations();

    // 2. Start Express HTTP Server
    const server = app.listen(PORT, () => {
        console.log(`🚀 Server is running at http://localhost:${PORT}`);

        if (!ENABLE_CRON) {
            console.log('⏸️ Background jobs disabled (ENABLE_CRON=false).');
            return;
        }

        // 3. Initial camera status sync & capture
        syncCameraStatus();
        backfillCameraThumbnails().then(autoCaptureDueCameras);

        // 4. Start periodic cron jobs
        startCronJobs();
        // First start after the daily statistics were added: build them from history
        require('./services/dailyStats').backfillIfEmpty();

        // 5. Telegram bot (one consumer per bot, so only on the background-jobs instance)
        telegramService.startPolling();
    });

    // Graceful shutdown: Cloud Run / Docker send SIGTERM before stopping the container
    let shuttingDown = false;
    const shutdown = (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`🛑 ${signal} received, shutting down...`);
        telegramService.stopPolling();
        setTimeout(() => process.exit(1), 10000).unref();
        server.close(async () => {
            await mongoose.disconnect().catch(() => {});
            process.exit(0);
        });
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

// Direct execution
if (require.main === module) {
    startServer();
}

module.exports = { app, startServer };
