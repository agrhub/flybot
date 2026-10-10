const mongoose = require('mongoose');
const axios = require('axios');
const { Snapshot, Camera } = require('../models');
const aiService = require('../services/aiService');
const s3Service = require('../services/s3Service');
const { sendServerError } = require('../utils/http');
const { viewableCameras, canManageSerial } = require('../utils/ownership');
const { FRUIT_FLY, NON_PEST_LABELS, normalizeSpeciesExpr, isFruitFly } = require('../constants/species');
const { thresholdOf, riskLevel, worstRisk } = require('../constants/risk');
const { countPests } = require('../services/notificationService');
const forecastService = require('../services/forecastService');
const { latestProcessedByCamera } = require('../services/snapshotQueries');
const dailyStats = require('../services/dailyStats');
const { cardDueAt } = require('../services/maintenanceService');
const weatherService = require('../services/weatherService');
const degreeDayService = require('../services/degreeDayService');

/**
 * Get AI detection history with pagination (filter by specific camera or all cameras)
 */
async function getAiResults(req, res) {
    try {
        const userId = req.user.id;
        const { deviceSerial } = req.query;
        const page = parseInt(req.query.page, 10) || 1;
        // Capped at 500 (the Excel export size)
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 500);
        const skip = (page - 1) * limit;

        const userCams = await viewableCameras(req.user).select('deviceSerial');
        const allowedSerials = userCams.map(c => c.deviceSerial);

        // If user has 0 cameras, return empty list
        if (allowedSerials.length === 0) {
            return res.json({ success: true, total: 0, page, limit, results: [] });
        }

        const matchQuery = { aiProcessed: true };
        if (deviceSerial && deviceSerial !== 'all') {
            if (allowedSerials.length > 0 && !allowedSerials.includes(deviceSerial)) {
                return res.status(403).json({ success: false, message: "You do not have permission to access this camera." });
            }
            matchQuery.deviceSerial = deviceSerial;
        } else if (allowedSerials.length > 0) {
            matchQuery.deviceSerial = { $in: allowedSerials };
        } else if (userId) {
            return res.json({ success: true, total: 0, page, limit, results: [] });
        }

        if (req.query.startDate && req.query.endDate) {
            matchQuery.createdAt = {
                $gte: new Date(req.query.startDate),
                $lte: new Date(new Date(req.query.endDate).setHours(23, 59, 59, 999))
            };
        } else if (req.query.startDate) {
            matchQuery.createdAt = { $gte: new Date(req.query.startDate) };
        } else if (req.query.endDate) {
            matchQuery.createdAt = { $lte: new Date(new Date(req.query.endDate).setHours(23, 59, 59, 999)) };
        }

        const total = await Snapshot.countDocuments(matchQuery);
        const results = await Snapshot.find(matchQuery)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        res.json({
            success: true,
            total,
            page,
            limit,
            results
        });
    } catch (error) {
        console.error("❌ Error fetching AI history:", error);
        sendServerError(res, error);
    }
}

/**
 * Trigger Roboflow analysis on-demand for a specific snapshot
 */
async function analyzeRoboflowSnapshot(req, res) {
    try {
        const { snapshotId } = req.params;
        if (!mongoose.isValidObjectId(snapshotId)) {
            return res.status(404).json({ success: false, message: "Snapshot not found." });
        }
        const snap = await Snapshot.findById(snapshotId);
        // Same 404 for missing and not-owned snapshots
        if (!snap || !(await canManageSerial(req.user, snap.deviceSerial))) {
            return res.status(404).json({ success: false, message: "Snapshot not found." });
        }

        let buffer;
        if (snap.s3Key) {
            const s3Res = await s3Service.getS3Object(snap.s3Key);
            const chunks = [];
            for await (const chunk of s3Res.Body) chunks.push(chunk);
            buffer = Buffer.concat(chunks);
        } else if (snap.imageUrl) {
            const imgRes = await axios.get(snap.imageUrl, { responseType: 'arraybuffer' });
            buffer = Buffer.from(imgRes.data);
        }

        if (!buffer) return res.status(400).json({ success: false, message: "Could not retrieve snapshot image." });

        const base64Image = buffer.toString('base64');
        await aiService.analyzeInsectsRoboflow(base64Image, snap._id, snap.imageUrl);
        const updated = await Snapshot.findById(snapshotId);
        res.json({ success: true, snapshot: updated });
    } catch (error) {
        sendServerError(res, error);
    }
}

/**
 * Helper to compute Min/Max/Avg insect statistics for a given match filter
 */
async function computePeriodStats(matchFilter) {
    try {
        const statsAgg = await Snapshot.aggregate([
            { $match: matchFilter },
            {
                $project: {
                    count: {
                        $reduce: {
                            input: { $objectToArray: { $ifNull: ["$aiResults.summary", {}] } },
                            initialValue: 0,
                            in: { $add: ["$$value", { $ifNull: ["$$this.v", 0] }] }
                        }
                    }
                }
            },
            {
                $group: {
                    _id: null,
                    min: { $min: "$count" },
                    max: { $max: "$count" },
                    avg: { $avg: "$count" },
                    totalScans: { $sum: 1 }
                }
            }
        ]);

        if (statsAgg.length > 0) {
            return {
                min: statsAgg[0].min || 0,
                max: statsAgg[0].max || 0,
                avg: Math.round((statsAgg[0].avg || 0) * 10) / 10,
                totalScans: statsAgg[0].totalScans || 0
            };
        }
    } catch (e) {
        console.error("Period stats calculation error:", e);
    }
    return { min: 0, max: 0, avg: 0, totalScans: 0 };
}

/**
 * Min/Max/Avg per scan and scan count from daily rollup rows (same shape as computePeriodStats)
 */
function rollupPeriodStats(rows) {
    const scans = rows.reduce((sum, r) => sum + r.scans, 0);
    if (!scans) return { min: 0, max: 0, avg: 0, totalScans: 0 };
    const total = rows.reduce((sum, r) => sum + r.total, 0);
    return {
        min: rows.reduce((min, r) => Math.min(min, r.min), Infinity),
        max: rows.reduce((max, r) => Math.max(max, r.peak), 0),
        avg: Math.round((total / scans) * 10) / 10,
        totalScans: scans
    };
}

/**
 * Insect statistics grouped by time interval (hour, day, month) or custom date range
 */
async function getAiStatistics(req, res) {
    try {
        const userId = req.user.id;
        const { deviceSerial, mode, startDate: customStart, endDate: customEnd } = req.query;

        const userCams = await viewableCameras(req.user).select('deviceSerial');
        const allowedSerials = userCams.map(c => c.deviceSerial);

        // If user has 0 cameras, return empty immediately (no fake / unowned data)
        if (allowedSerials.length === 0) {
            return res.json({
                success: true,
                mode: mode || 'day',
                deviceSerial: deviceSerial || 'all',
                data: []
            });
        }

        // 1. Determine date format based strictly on grouping mode
        let dateKeyFormat = "%Y-%m-%d";
        let displayFormat = "%d/%m";

        if (mode === 'hour') {
            dateKeyFormat = "%Y-%m-%d %H:00";
            displayFormat = "%H:00";
        } else if (mode === 'month') {
            dateKeyFormat = "%Y-%m";
            displayFormat = "%m/%Y";
        } else {
            // mode === 'day' (default)
            dateKeyFormat = "%Y-%m-%d";
            displayFormat = "%d/%m";
        }

        // 2. Determine date filter range
        let startDate = new Date();
        let endDate = null;

        if (customStart) {
            startDate = new Date(customStart);
            if (customEnd) {
                endDate = new Date(customEnd);
                endDate.setHours(23, 59, 59, 999);
            }
            // If user requests 'hour' mode without a specific endDate, cap to past 24-48h
            // to avoid rendering an overwhelming number of hourly points
            if (mode === 'hour' && !customEnd) {
                const now = new Date();
                const diffHours = (now - startDate) / (1000 * 60 * 60);
                if (diffHours > 48) {
                    startDate = new Date();
                    startDate.setHours(startDate.getHours() - 24);
                }
            }
        } else if (mode === 'hour') {
            startDate.setHours(startDate.getHours() - 24);
        } else if (mode === 'month') {
            startDate.setFullYear(startDate.getFullYear() - 1);
        } else {
            // Default: past 30 days
            startDate.setDate(startDate.getDate() - 30);
        }

        // Hourly buckets over months (or daily over years) are expensive and unreadable
        const MAX_RANGE_DAYS = { hour: 7, day: 400, month: 400 };
        const maxRangeMs = (MAX_RANGE_DAYS[mode] || MAX_RANGE_DAYS.day) * 24 * 60 * 60 * 1000;
        const rangeEnd = endDate || new Date();
        if (isNaN(startDate) || (endDate && isNaN(endDate))) {
            return res.status(400).json({ success: false, message: "Invalid date range." });
        }
        if (rangeEnd - startDate > maxRangeMs) startDate = new Date(rangeEnd.getTime() - maxRangeMs);

        const matchQuery = {
            aiProcessed: true
        };

        if (endDate) {
            matchQuery.createdAt = { $gte: startDate, $lte: endDate };
        } else {
            matchQuery.createdAt = { $gte: startDate };
        }

        if (deviceSerial && deviceSerial !== 'all') {
            if (!allowedSerials.includes(deviceSerial)) {
                return res.status(403).json({ success: false, message: "You do not have permission to access this camera." });
            }
            matchQuery.deviceSerial = deviceSerial;
        } else {
            matchQuery.deviceSerial = { $in: allowedSerials };
        }

        // Daily and monthly charts come from the daily rollup; hourly (at most 7 days) from snapshots
        if (mode !== 'hour') {
            const serials = typeof matchQuery.deviceSerial === 'string' ? [matchQuery.deviceSerial] : matchQuery.deviceSerial.$in;
            const rollup = await dailyStats.rows(serials, dailyStats.dayKeyOf(startDate), endDate ? dailyStats.dayKeyOf(endDate) : null);
            return res.json({
                success: true,
                mode: mode || 'day',
                deviceSerial: deviceSerial || 'all',
                data: dailyStats.speciesSeries(rollup, mode === 'month' ? 'month' : 'day')
            });
        }

        const data = await Snapshot.aggregate([
            { $match: matchQuery },
            {
                $project: {
                    deviceSerial: 1,
                    createdAt: 1,
                    dateKey: { $dateToString: { format: dateKeyFormat, date: "$createdAt", timezone: "Asia/Ho_Chi_Minh" } },
                    displayKey: { $dateToString: { format: displayFormat, date: "$createdAt", timezone: "Asia/Ho_Chi_Minh" } },
                    rawSummary: { $objectToArray: { $ifNull: ["$aiResults.summary", {}] } }
                }
            },
            // Fallback to fruit fly with count 0 if summary is empty
            {
                $addFields: {
                    summaryArray: {
                        $cond: [
                            { $gt: [{ $size: "$rawSummary" }, 0] },
                            "$rawSummary",
                            [{ k: FRUIT_FLY, v: 0 }]
                        ]
                    }
                }
            },
            { $unwind: "$summaryArray" },
            {
                $addFields: {
                    normalizedInsect: normalizeSpeciesExpr("$summaryArray.k")
                }
            },
            // Step 1: Compute peak insect density per camera per time interval
            {
                $group: {
                    _id: {
                        dateKey: "$dateKey",
                        displayKey: "$displayKey",
                        camera: "$deviceSerial",
                        insect: "$normalizedInsect"
                    },
                    camMax: { $max: { $ifNull: ["$summaryArray.v", 0] } }
                }
            },
            // Step 2: Sum density across traps for that time interval
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
            // Filter non-pest artifacts (keep pests such as fruit flies, caterpillars, moths, thrips)
            {
                $match: {
                    "_id.insect": { $nin: NON_PEST_LABELS }
                }
            },
            // Step 3: Group by time interval
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
            // Step 4: Sort chronologically by dateKey
            { $sort: { "_id.dateKey": 1 } },
            {
                $project: {
                    _id: "$_id.displayKey",
                    dateKey: "$_id.dateKey",
                    insects: 1
                }
            }
        ]);

        res.json({
            success: true,
            mode: mode || 'day',
            deviceSerial: deviceSerial || 'all',
            data: data
        });
    } catch (error) {
        console.error("❌ Statistics error:", error);
        sendServerError(res, error);
    }
}

/**
 * Dashboard Overview: Realtime camera counts, hotspot peak count, min/max/avg historical stats, top species
 */
async function getAiOverview(req, res) {
    try {
        const userId = req.user.id;
        const userCameras = await viewableCameras(req.user);

        const cameraMap = new Map();
        userCameras.forEach(c => {
            if (!cameraMap.has(c.deviceSerial)) cameraMap.set(c.deviceSerial, c);
        });
        const dedupedCameras = Array.from(cameraMap.values());

        // If user has NO cameras, immediately return zeroed stats (no fake data or data from other users)
        if (dedupedCameras.length === 0) {
            return res.json({
                success: true,
                overview: {
                    totalCameras: 0,
                    onlineCameras: 0,
                    peakRealtimeInsects: 0,
                    peakCamera: null,
                    totalRealtimeInsects: 0,
                    cameraRealtimeList: [],
                    overallRisk: 'low',
                    historicalStats: {
                        day: { min: 0, max: 0, avg: 0, totalScans: 0 },
                        week: { min: 0, max: 0, avg: 0, totalScans: 0 },
                        month: { min: 0, max: 0, avg: 0, totalScans: 0 }
                    },
                    totalSnapshots: 0,
                    last24hCount: 0,
                    topSpecies: '--',
                    speciesSummary: {},
                    speciesBreakdown: [],
                    trend7Days: []
                }
            });
        }

        const cameraSerials = dedupedCameras.map(c => c.deviceSerial);
        const matchQuery = {
            aiProcessed: true,
            deviceSerial: { $in: cameraSerials }
        };

        // 1. Compute realtime insect count per camera from its latest processed snapshot
        const cameraRealtimeList = [];
        let peakRealtimeInsects = 0;
        let peakCamera = null;
        let totalRealtimeInsects = 0;
        const latestByCamera = await latestProcessedByCamera(cameraSerials);

        for (const cam of dedupedCameras) {
            // Same counting as alerts and diagnosis: pests only (no people, cars...)
            const extractCount = (snap) => {
                if (!snap) return 0;
                if (snap.summary) return countPests(snap.summary);
                return Array.isArray(snap.insects) ? snap.insects.length : 0;
            };

            const latestSnapshot = latestByCamera.get(cam.deviceSerial);

            let currentCount = 0;
            let lastScanTime = null;
            let lastImageUrl = '';

            if (latestSnapshot) {
                lastScanTime = latestSnapshot.createdAt;
                lastImageUrl = latestSnapshot.imageUrl || '';
                currentCount = extractCount(latestSnapshot);
            }

            if (currentCount > peakRealtimeInsects) {
                peakRealtimeInsects = currentCount;
                peakCamera = {
                    deviceSerial: cam.deviceSerial,
                    deviceName: cam.deviceName || cam.deviceSerial,
                    locationAddress: cam.locationAddress || ''
                };
            }

            totalRealtimeInsects += currentCount;

            // Risk against this camera's own alert threshold (Settings > Notifications)
            const alertThreshold = thresholdOf(cam);
            const camRisk = riskLevel(currentCount, alertThreshold);

            cameraRealtimeList.push({
                deviceSerial: cam.deviceSerial,
                deviceName: cam.deviceName || cam.deviceSerial,
                locationAddress: cam.locationAddress || '',
                // null when the trap has no GPS position yet (never a made-up default)
                latitude: Number.isFinite(cam.latitude) ? cam.latitude : null,
                longitude: Number.isFinite(cam.longitude) ? cam.longitude : null,
                trapType: cam.trapType || 'Yellow Sticky Trap',
                cropType: cam.cropType || 'Mango Orchard',
                currentCount,
                riskLevel: camRisk,
                alertThreshold,
                status: cam.status ?? 1,
                lastScanTime,
                lastImageUrl,
                // Sticky card reminder date (null when reminders are off)
                cardDueAt: cardDueAt(cam)
            });
        }

        // 2. Real historical stats (Min, Max, Avg, totalScans) for Day (24h), Week (7d), Month (30d)
        const now = Date.now();
        const last24h = new Date(now - 24 * 60 * 60 * 1000);

        // Last 24 h from snapshots (rolling window); 7 and 30 days from the daily rollup
        const [statsDay, rollup30] = await Promise.all([
            computePeriodStats({ ...matchQuery, createdAt: { $gte: last24h } }),
            dailyStats.rows(cameraSerials, dailyStats.startKeyForDays(30))
        ]);
        const rollup7 = rollup30.filter(r => r.day >= dailyStats.startKeyForDays(7));
        const statsWeek = rollupPeriodStats(rollup7);
        const statsMonth = rollupPeriodStats(rollup30);

        // 3. Total processed snapshots & 24h count
        const totalSnapshots = await Snapshot.countDocuments(matchQuery);
        const last24hCount = statsDay.totalScans || await Snapshot.countDocuments({
            ...matchQuery,
            createdAt: { $gte: last24h }
        });

        // 4. Species breakdown over the last 30 days
        const speciesAgg = dailyStats.speciesTotals(rollup30, 'total').map(sp => ({ _id: sp.name, total: sp.value }));

        let allTimeSum = 0;
        const speciesSummary = {};
        speciesAgg.forEach(item => {
            allTimeSum += item.total;
            speciesSummary[item._id] = item.total;
        });

        const topSpecies = speciesAgg.length > 0
            ? `${speciesAgg[0]._id} (${Math.round((speciesAgg[0].total / (allTimeSum || 1)) * 100)}%)`
            : '--';

        // 5. Past 7-day trend: insects counted per day (all scans, all cameras)
        const trendByDay = new Map();
        for (const r of rollup7) trendByDay.set(r.day, (trendByDay.get(r.day) || 0) + r.total);
        const trendAgg = [...trendByDay.keys()].sort().map(day => {
            const [, m, d] = day.split('-');
            return { _id: `${d}/${m}`, count: trendByDay.get(day) };
        });

        // Overall risk index
        // Worst camera, each judged against its own threshold
        const overallRisk = worstRisk(cameraRealtimeList.map(c => c.riskLevel));

        res.json({
            success: true,
            overview: {
                peakRealtimeInsects,
                peakCamera: peakCamera || (cameraRealtimeList[0] || null),
                totalRealtimeInsects,
                cameraRealtimeList,
                overallRisk,
                historicalStats: {
                    day: statsDay,
                    week: statsWeek,
                    month: statsMonth
                },
                totalSnapshots,
                last24hCount,
                topSpecies,
                speciesSummary,
                speciesBreakdown: speciesAgg,
                trend7Days: trendAgg.length > 0 ? trendAgg : []
            }
        });
    } catch (err) {
        console.error("❌ Error fetching AI overview:", err);
        sendServerError(res, err);
    }
}

const TIMEZONE = 'Asia/Ho_Chi_Minh';
const HISTORY_DAYS = 14;
const FORECAST_DAYS = 7;


const dayKey = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(date); // YYYY-MM-DD
const dayLabel = (date) => new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, day: '2-digit', month: '2-digit' }).format(date); // DD/MM

function emptyDiagnosis() {
    return {
        riskLevel: 'low',
        riskScore: 0,
        currentPeakCount: 0,
        peakCamera: null,
        referenceThreshold: null,
        dominantPest: null,
        weather: null,
        weatherFactor: null,
        forecast: { trajectory: 'stable', confidence: 'low', dataDays: 0, projectedPeakDate: '', days: [] },
        recommendations: []
    };
}

/**
 * Rule-based IPM advice from the current risk, trend and weather.
 * Texts live in the client i18n files (dashboard.diagnosis.recs.<key>).
 */
function buildRecommendations({ risk, trajectory, weatherFactor, hasDetections, affectedTraps }) {
    if (!hasDetections) return [];
    const favorable = weatherFactor === 'hot_humid';
    const recs = [];
    const add = (id, key, urgency, targetsTraps = false) =>
        recs.push({ id, key, urgency, ...(targetsTraps ? { targetCameras: affectedTraps } : {}) });

    if (risk === 'high') {
        add('REC-01', 'pheromoneLure', 'urgent', true);
        add('REC-02', 'proteinBait', 'urgent', true);
        add('REC-03', 'fieldSanitation', 'important');
        add('REC-04', 'fruitBagging', 'important');
    } else if (risk === 'moderate') {
        add('REC-01', 'pheromoneLure', trajectory === 'surging' ? 'urgent' : 'recommended', true);
        add('REC-02', 'proteinBait', favorable || trajectory === 'surging' ? 'important' : 'recommended', true);
        add('REC-03', 'fieldSanitation', 'routine');
        if (trajectory === 'surging') add('REC-04', 'fruitBagging', 'recommended');
    } else {
        add('REC-03', 'fieldSanitation', 'routine');
        if (trajectory === 'surging' || favorable) add('REC-01', 'pheromoneLure', 'recommended', affectedTraps.length > 0);
    }
    return recs;
}

/**
 * AI Copilot: current risk, 7-day trend forecast and actionable IPM plan.
 * Every number is computed from this user's data; nothing is a fixed placeholder.
 */
async function getAiDiagnosis(req, res) {
    try {
        const { deviceSerial } = req.body;
        const userId = req.user.id;

        const userCameras = await viewableCameras(req.user);
        const bySerial = new Map();
        userCameras.forEach(c => { if (!bySerial.has(c.deviceSerial)) bySerial.set(c.deviceSerial, c); });
        let cameras = [...bySerial.values()];
        if (cameras.length === 0) {
            return res.json({ success: true, diagnosis: emptyDiagnosis() });
        }
        if (deviceSerial && deviceSerial !== 'all') {
            cameras = cameras.filter(c => c.deviceSerial === deviceSerial);
            if (cameras.length === 0) {
                return res.status(403).json({ success: false, message: "You do not have permission to access this camera." });
            }
        }
        const serials = cameras.map(c => c.deviceSerial);

        // 1. Current state: latest processed snapshot of each camera vs its own threshold
        const current = [];
        const latestByCamera = await latestProcessedByCamera(serials);
        for (const cam of cameras) {
            const snap = latestByCamera.get(cam.deviceSerial);
            const count = snap ? countPests(snap.summary) : 0;
            const threshold = thresholdOf(cam);
            current.push({ cam, count, threshold, risk: riskLevel(count, threshold), ratio: count / threshold });
        }
        const peak = current.reduce((best, c) => (c.ratio > best.ratio ? c : best), current[0]);
        const overallRisk = worstRisk(current.map(c => c.risk));
        // Forecast risk is judged against the most sensitive camera's threshold
        const referenceThreshold = Math.min(...current.map(c => c.threshold));
        const affectedTraps = current.filter(c => c.risk !== 'low').map(c => c.cam.deviceName || c.cam.deviceSerial);

        // 2. History: highest single-trap count per day over the last HISTORY_DAYS days
        const now = new Date();
        const windowKeys = [];
        for (let i = HISTORY_DAYS - 1; i >= 0; i--) windowKeys.push(dayKey(new Date(now.getTime() - i * 86400000)));

        // Highest single-trap count per day, and the most counted species, over the window
        const history = await dailyStats.rows(serials, windowKeys[0]);
        const peakByDay = new Map();
        for (const r of history) peakByDay.set(r.day, Math.max(peakByDay.get(r.day) || 0, r.peak));
        const daily = [...peakByDay.entries()].map(([day, peak]) => ({ _id: day, peak }));
        const species = dailyStats.speciesTotals(history, 'total')
            .filter(sp => sp.value > 0)
            .map(sp => ({ _id: sp.name, total: sp.value }));

        const points = daily
            .map(d => ({ dayIndex: windowKeys.indexOf(d._id), value: d.peak || 0 }))
            .filter(p => p.dayIndex >= 0)
            .sort((a, b) => a.dayIndex - b.dayIndex);
        const hasDetections = peak.count > 0 || points.some(p => p.value > 0);

        const trend = forecastService.forecast(points, HISTORY_DAYS, FORECAST_DAYS);
        const forecastDays = trend.projected.map((projectedCount, i) => ({
            date: dayLabel(new Date(now.getTime() + (i + 1) * 86400000)),
            projectedCount,
            risk: riskLevel(projectedCount, referenceThreshold)
        }));

        // 3. Weather at the peak trap (or any trap with GPS)
        const located = [peak.cam, ...cameras].find(c => Number.isFinite(c.latitude) && Number.isFinite(c.longitude));
        const [weather, degreeDays] = await Promise.all([
            located ? weatherService.getCurrentWeather(located.latitude, located.longitude) : null,
            // Next adult wave from accumulated heat; optional, never fails the diagnosis
            degreeDayService.forCameras([peak.cam, ...cameras.filter(c => c !== peak.cam)]).catch(err => {
                console.warn('⚠️ Degree-day model failed:', err.message);
                return null;
            })
        ]);
        const factor = weatherService.weatherFactor(weather);

        res.json({
            success: true,
            diagnosis: {
                riskLevel: overallRisk,
                // Peak count as a percentage of that camera's alert threshold
                riskScore: Math.min(100, Math.round(peak.ratio * 100)),
                currentPeakCount: peak.count,
                peakCamera: {
                    deviceSerial: peak.cam.deviceSerial,
                    deviceName: peak.cam.deviceName || peak.cam.deviceSerial,
                    alertThreshold: peak.threshold
                },
                referenceThreshold,
                dominantPest: species[0]?._id || null,
                weather,
                weatherFactor: factor,
                degreeDays,
                forecast: {
                    trajectory: trend.trajectory,
                    confidence: trend.confidence, // 'low' | 'medium' | 'high'
                    dataDays: trend.dataDays,
                    projectedPeakDate: forecastDays.reduce((best, d) => (d.projectedCount > best.projectedCount ? d : best), forecastDays[0]).date,
                    days: forecastDays
                },
                recommendations: buildRecommendations({
                    risk: overallRisk,
                    trajectory: trend.trajectory,
                    weatherFactor: factor,
                    hasDetections,
                    affectedTraps
                })
            }
        });
    } catch (err) {
        console.error("❌ Error in AI Diagnosis:", err);
        sendServerError(res, err);
    }
}

const MAX_REVIEW_LABELS = 20;
const MAX_REVIEW_COUNT = 10000;

/**
 * Validate and normalize a corrected summary { label: count } from the client.
 * Returns { summary } or { error }.
 */
function parseCorrectedSummary(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'summary must be an object of label: count.' };
    const entries = Object.entries(input);
    if (entries.length > MAX_REVIEW_LABELS) return { error: `At most ${MAX_REVIEW_LABELS} labels.` };
    const summary = {};
    for (const [rawLabel, count] of entries) {
        const label = String(rawLabel).trim().toLowerCase();
        // Labels become Mongo map keys: no dots or leading "$"
        if (!label || label.length > 40 || /[.$]/.test(label)) return { error: `Invalid label "${rawLabel}".` };
        if (!Number.isInteger(count) || count < 0 || count > MAX_REVIEW_COUNT) return { error: `Invalid count for "${rawLabel}".` };
        const key = isFruitFly(label) ? FRUIT_FLY : label;
        summary[key] = (summary[key] || 0) + count;
    }
    return { summary };
}

/**
 * PUT /api/ai/snapshots/:snapshotId/review
 * { status: 'confirmed' } or { status: 'corrected', summary: { fruit_fly: 3 }, note? }
 */
async function reviewSnapshot(req, res) {
    try {
        const { snapshotId } = req.params;
        const { status, summary, note } = req.body;
        if (!mongoose.isValidObjectId(snapshotId)) {
            return res.status(404).json({ success: false, message: "Snapshot not found." });
        }
        if (!['confirmed', 'corrected'].includes(status)) {
            return res.status(400).json({ success: false, message: "status must be 'confirmed' or 'corrected'." });
        }
        if (note !== undefined && (typeof note !== 'string' || note.length > 500)) {
            return res.status(400).json({ success: false, message: "note must be text up to 500 characters." });
        }

        const snap = await Snapshot.findById(snapshotId);
        // Same 404 for missing and not-owned snapshots
        if (!snap || !(await canManageSerial(req.user, snap.deviceSerial))) {
            return res.status(404).json({ success: false, message: "Snapshot not found." });
        }
        if (!snap.aiProcessed) {
            return res.status(400).json({ success: false, message: "This snapshot has not been analyzed yet." });
        }

        const currentSummary = snap.aiResults?.summary instanceof Map
            ? Object.fromEntries(snap.aiResults.summary)
            : (snap.aiResults?.summary || {});
        // Keep the very first model output, even across repeated corrections
        const original = snap.review?.originalSummary
            ? (snap.review.originalSummary instanceof Map ? Object.fromEntries(snap.review.originalSummary) : snap.review.originalSummary)
            : currentSummary;

        if (status === 'corrected') {
            const parsed = parseCorrectedSummary(summary);
            if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
            snap.set('aiResults.summary', parsed.summary);
            snap.set('aiResults.detected', Object.values(parsed.summary).some(v => v > 0));
        }

        snap.set('review', {
            status,
            originalSummary: original,
            note: note ? note.trim() : undefined,
            reviewedBy: req.user.id,
            reviewedAt: new Date()
        });
        // Queue the reviewed photo for the retraining dataset
        require('../services/trainingSync').markPending(snap);
        await snap.save();
        await dailyStats.refreshForSnapshot(snap);

        res.json({ success: true, snapshot: snap });
    } catch (err) {
        sendServerError(res, err, { context: 'Review snapshot' });
    }
}

/**
 * GET /api/ai/reviews/export?days=90
 * Corrected snapshots with the model output and the human counts, for retraining the detector.
 */
async function exportReviews(req, res) {
    try {
        const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 365);
        const userCameras = await viewableCameras(req.user).select('deviceSerial');
        const serials = [...new Set(userCameras.map(c => c.deviceSerial))];
        const since = new Date(Date.now() - days * 86400000);

        const snaps = await Snapshot.find({
            deviceSerial: { $in: serials },
            'review.status': 'corrected',
            'review.reviewedAt': { $gte: since }
        }).sort({ 'review.reviewedAt': -1 }).limit(5000);

        const toObject = (m) => (m instanceof Map ? Object.fromEntries(m) : (m || {}));
        res.json({
            success: true,
            exportedAt: new Date(),
            days,
            items: snaps.map(s => ({
                snapshotId: s._id,
                deviceSerial: s.deviceSerial,
                capturedAt: s.createdAt,
                s3Key: s.s3Key,
                aiProvider: s.aiProvider,
                modelSummary: toObject(s.review?.originalSummary),
                correctedSummary: toObject(s.aiResults?.summary),
                modelDetections: s.aiResults?.insects || [],
                note: s.review?.note || '',
                reviewedAt: s.review?.reviewedAt
            }))
        });
    } catch (err) {
        sendServerError(res, err, { context: 'Export reviews' });
    }
}

const COMPARISON_PERIODS = [7, 14, 30];

const percentChange = (current, previous) =>
    (previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null);

/**
 * GET /api/ai/comparison?days=7|14|30
 * This period vs the one before it (totals, average per scan, peak), overall and per camera.
 */
async function getAiComparison(req, res) {
    try {
        const days = Number(req.query.days) || 7;
        if (!COMPARISON_PERIODS.includes(days)) {
            return res.status(400).json({ success: false, message: `days must be one of ${COMPARISON_PERIODS.join(', ')}.` });
        }
        const userId = req.user.id;
        const userCameras = await viewableCameras(req.user);
        const bySerial = new Map();
        userCameras.forEach(c => { if (!bySerial.has(c.deviceSerial)) bySerial.set(c.deviceSerial, c); });
        const cameras = [...bySerial.values()];

        const now = new Date();
        const currentStart = new Date(now.getTime() - days * 86400000);
        const previousStart = new Date(now.getTime() - 2 * days * 86400000);

        const emptyPeriod = (start, end) => ({ start, end, totalInsects: 0, scans: 0, avgPerScan: 0, peakCount: 0 });
        if (cameras.length === 0) {
            return res.json({
                success: true,
                comparison: {
                    days,
                    current: emptyPeriod(currentStart, now),
                    previous: emptyPeriod(previousStart, currentStart),
                    change: { totalInsects: null, avgPerScan: null, peakCount: null },
                    cameras: []
                }
            });
        }

        // Whole local days from the rollup: "last 7 days" = today and the 6 days before it
        const currentKey = dailyStats.startKeyForDays(days);
        const rollup = await dailyStats.rows(cameras.map(c => c.deviceSerial), dailyStats.startKeyForDays(2 * days));
        const rows = [];
        for (const r of rollup) {
            rows.push({ _id: { serial: r.deviceSerial, isCurrent: r.day >= currentKey }, total: r.total, scans: r.scans, peak: r.peak });
        }

        const summarize = (list) => {
            const totalInsects = list.reduce((s, r) => s + r.total, 0);
            const scans = list.reduce((s, r) => s + r.scans, 0);
            return {
                totalInsects,
                scans,
                avgPerScan: scans > 0 ? Math.round((totalInsects / scans) * 10) / 10 : 0,
                peakCount: list.reduce((m, r) => Math.max(m, r.peak || 0), 0)
            };
        };
        const currentRows = rows.filter(r => r._id.isCurrent);
        const previousRows = rows.filter(r => !r._id.isCurrent);
        const current = { start: currentStart, end: now, ...summarize(currentRows) };
        const previous = { start: previousStart, end: currentStart, ...summarize(previousRows) };

        const cameraRows = cameras.map(cam => {
            const cur = summarize(currentRows.filter(r => r._id.serial === cam.deviceSerial));
            const prev = summarize(previousRows.filter(r => r._id.serial === cam.deviceSerial));
            return {
                deviceSerial: cam.deviceSerial,
                deviceName: cam.deviceName || cam.deviceSerial,
                alertThreshold: thresholdOf(cam),
                ...cur,
                // Risk of the period's peak against this camera's threshold
                riskLevel: riskLevel(cur.peakCount, thresholdOf(cam)),
                previousTotal: prev.totalInsects,
                changePct: percentChange(cur.totalInsects, prev.totalInsects)
            };
        }).sort((a, b) => b.totalInsects - a.totalInsects);

        res.json({
            success: true,
            comparison: {
                days,
                current,
                previous,
                // null when the previous period had nothing to compare against
                change: {
                    totalInsects: percentChange(current.totalInsects, previous.totalInsects),
                    avgPerScan: percentChange(current.avgPerScan, previous.avgPerScan),
                    peakCount: percentChange(current.peakCount, previous.peakCount)
                },
                cameras: cameraRows
            }
        });
    } catch (err) {
        sendServerError(res, err, { context: 'AI comparison' });
    }
}

const agent = require('../agent/agent');
const MAX_CHAT_MESSAGE = 4000;
const MAX_UI_CONTEXT = 8000;

/**
 * AI Agent Chatbot with Function Tools, Context Injection, and Action Execution
 */
async function chatWithAssistant(req, res) {
    try {
        const userId = req.user.id;
        const { message, sessionId = 'default-session', uiContext = {} } = req.body;
        if (typeof message !== 'string' || !message.trim()) {
            return res.status(400).json({ success: false, message: "Message cannot be empty." });
        }
        // Everything here goes into the model prompt: keep it small
        if (message.length > MAX_CHAT_MESSAGE) {
            return res.status(400).json({ success: false, message: `Message is too long (at most ${MAX_CHAT_MESSAGE} characters).` });
        }
        if (JSON.stringify(uiContext ?? {}).length > MAX_UI_CONTEXT) {
            return res.status(400).json({ success: false, message: "Page context is too large." });
        }

        const result = await agent.chatWithAgent({
            sessionId: String(sessionId),
            message,
            uiContext,
            userId,
            user: req.user
        });

        res.json({
            success: true,
            reply: result.reply,
            suggestions: result.suggestions,
            navigate: result.navigate,
            actions: result.actions,
            toolExecutions: result.toolExecutions
        });
    } catch (err) {
        console.error("❌ AI Agent chat error:", err);
        sendServerError(res, err);
    }
}

async function clearChatSession(req, res) {
    try {
        const { sessionId = 'default-session' } = req.body;
        agent.clearChatHistory(req.user.id, String(sessionId));
        res.json({ success: true, message: "Chat session refreshed successfully." });
    } catch (err) {
        sendServerError(res, err);
    }
}

module.exports = {
    getAiResults,
    analyzeRoboflowSnapshot,
    getAiStatistics,
    getAiOverview,
    getAiDiagnosis,
    getAiComparison,
    reviewSnapshot,
    exportReviews,
    chatWithAssistant,
    clearChatSession
};
