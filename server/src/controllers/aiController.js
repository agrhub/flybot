const mongoose = require('mongoose');
const axios = require('axios');
const { Snapshot, Camera } = require('../models');
const aiService = require('../services/aiService');
const s3Service = require('../services/s3Service');
const { sendServerError } = require('../utils/http');
const { userOwnsCamera } = require('../utils/ownership');
const { FRUIT_FLY, NON_PEST_LABELS, normalizeSpeciesExpr } = require('../constants/species');
const { thresholdOf, riskLevel, worstRisk } = require('../constants/risk');
const { countPests } = require('../services/notificationService');
const forecastService = require('../services/forecastService');
const weatherService = require('../services/weatherService');

/**
 * Get AI detection history with pagination (filter by specific camera or all cameras)
 */
async function getAiResults(req, res) {
    try {
        const userId = req.user.id;
        const { deviceSerial } = req.query;
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 10;
        const skip = (page - 1) * limit;

        const userCams = await Camera.find({ userId }).select('deviceSerial');
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
        if (!snap || !(await userOwnsCamera(req.user.id, snap.deviceSerial))) {
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
 * Insect statistics grouped by time interval (hour, day, month) or custom date range
 */
async function getAiStatistics(req, res) {
    try {
        const userId = req.user.id;
        const { deviceSerial, mode, startDate: customStart, endDate: customEnd } = req.query;

        const userCams = await Camera.find({ userId }).select('deviceSerial');
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
        const userCameras = await Camera.find({ userId });

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

        for (const cam of dedupedCameras) {
            // Same counting as alerts and diagnosis: pests only (no people, cars...)
            const extractCount = (snap) => {
                if (!snap) return 0;
                if (snap.aiResults?.summary) return countPests(snap.aiResults.summary);
                return Array.isArray(snap.aiResults?.insects) ? snap.aiResults.insects.length : 0;
            };

            let latestSnapshot = await Snapshot.findOne({
                deviceSerial: cam.deviceSerial,
                aiProcessed: true
            }).sort({ createdAt: -1 });

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
                lastImageUrl
            });
        }

        // 2. Real historical stats (Min, Max, Avg, totalScans) for Day (24h), Week (7d), Month (30d)
        const now = Date.now();
        const last24h = new Date(now - 24 * 60 * 60 * 1000);
        const last7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
        const last30d = new Date(now - 30 * 24 * 60 * 60 * 1000);

        const [statsDay, statsWeek, statsMonth] = await Promise.all([
            computePeriodStats({ ...matchQuery, createdAt: { $gte: last24h } }),
            computePeriodStats({ ...matchQuery, createdAt: { $gte: last7d } }),
            computePeriodStats({ ...matchQuery, createdAt: { $gte: last30d } })
        ]);

        // 3. Total processed snapshots & 24h count
        const totalSnapshots = await Snapshot.countDocuments(matchQuery);
        const last24hCount = statsDay.totalScans || await Snapshot.countDocuments({
            ...matchQuery,
            createdAt: { $gte: last24h }
        });

        // 4. Species breakdown
        const speciesAgg = await Snapshot.aggregate([
            { $match: matchQuery },
            {
                $project: {
                    summaryArray: { $objectToArray: "$aiResults.summary" }
                }
            },
            { $unwind: "$summaryArray" },
            {
                $addFields: {
                    normalizedName: normalizeSpeciesExpr("$summaryArray.k")
                }
            },
            {
                $group: {
                    _id: "$normalizedName",
                    total: { $sum: "$summaryArray.v" }
                }
            },
            { $sort: { total: -1 } }
        ]);

        let allTimeSum = 0;
        const speciesSummary = {};
        speciesAgg.forEach(item => {
            allTimeSum += item.total;
            speciesSummary[item._id] = item.total;
        });

        const topSpecies = speciesAgg.length > 0
            ? `${speciesAgg[0]._id} (${Math.round((speciesAgg[0].total / (allTimeSum || 1)) * 100)}%)`
            : '--';

        // 5. Past 7-day trend
        const trendAgg = await Snapshot.aggregate([
            {
                $match: {
                    ...matchQuery,
                    createdAt: { $gte: last7d }
                }
            },
            {
                $project: {
                    date: { $dateToString: { format: "%d/%m", date: "$createdAt", timezone: "Asia/Ho_Chi_Minh" } },
                    summaryArray: { $objectToArray: "$aiResults.summary" }
                }
            },
            { $unwind: "$summaryArray" },
            {
                $group: {
                    _id: "$date",
                    count: { $sum: "$summaryArray.v" }
                }
            },
            { $sort: { _id: 1 } }
        ]);

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

// Sum of pest counts in a snapshot summary, excluding non-pest detections
const PEST_COUNT_EXPR = {
    $reduce: {
        input: { $objectToArray: { $ifNull: ['$aiResults.summary', {}] } },
        initialValue: 0,
        in: {
            $add: ['$$value', {
                $cond: [{ $in: [{ $toLower: '$$this.k' }, NON_PEST_LABELS] }, 0, { $ifNull: ['$$this.v', 0] }]
            }]
        }
    }
};

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

        const userCameras = await Camera.find({ userId });
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
        for (const cam of cameras) {
            const snap = await Snapshot.findOne({ deviceSerial: cam.deviceSerial, aiProcessed: true }).sort({ createdAt: -1 });
            const count = snap ? countPests(snap.aiResults?.summary) : 0;
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
        const windowStart = new Date(now.getTime() - HISTORY_DAYS * 86400000);

        const [daily, species] = await Promise.all([
            Snapshot.aggregate([
                { $match: { deviceSerial: { $in: serials }, aiProcessed: true, createdAt: { $gte: windowStart } } },
                { $project: { day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TIMEZONE } }, count: PEST_COUNT_EXPR } },
                { $group: { _id: '$day', peak: { $max: '$count' } } }
            ]),
            Snapshot.aggregate([
                { $match: { deviceSerial: { $in: serials }, aiProcessed: true, createdAt: { $gte: windowStart } } },
                { $project: { summaryArray: { $objectToArray: { $ifNull: ['$aiResults.summary', {}] } } } },
                { $unwind: '$summaryArray' },
                { $match: { 'summaryArray.k': { $nin: NON_PEST_LABELS } } },
                { $group: { _id: normalizeSpeciesExpr('$summaryArray.k'), total: { $sum: '$summaryArray.v' } } },
                { $sort: { total: -1 } },
                { $limit: 1 }
            ])
        ]);

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
        const weather = located ? await weatherService.getCurrentWeather(located.latitude, located.longitude) : null;
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

const agent = require('../agent/agent');

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

        const result = await agent.chatWithAgent({
            sessionId: String(sessionId),
            message,
            uiContext,
            userId
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
    chatWithAssistant,
    clearChatSession
};
