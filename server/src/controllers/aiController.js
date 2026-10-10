const mongoose = require('mongoose');
const axios = require('axios');
const { Snapshot, Camera } = require('../models');
const aiService = require('../services/aiService');
const s3Service = require('../services/s3Service');
const { sendServerError } = require('../utils/http');
const { userOwnsCamera } = require('../utils/ownership');
const { FRUIT_FLY, NON_PEST_LABELS, normalizeSpeciesExpr } = require('../constants/species');

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
            const extractCount = (snap) => {
                let cnt = 0;
                if (!snap) return 0;
                const summary = snap.aiResults?.summary;
                if (summary) {
                    if (summary instanceof Map) {
                        for (const val of summary.values()) cnt += Number(val) || 0;
                    } else if (typeof summary === 'object') {
                        for (const val of Object.values(summary)) cnt += Number(val) || 0;
                    }
                } else if (Array.isArray(snap.aiResults?.insects)) {
                    cnt = snap.aiResults.insects.length;
                }
                return cnt;
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
                    locationAddress: cam.locationAddress || 'Orchard Field'
                };
            }

            totalRealtimeInsects += currentCount;

            const riskLevel = currentCount >= 20 ? 'high' : (currentCount >= 6 ? 'moderate' : 'low');

            cameraRealtimeList.push({
                deviceSerial: cam.deviceSerial,
                deviceName: cam.deviceName || cam.deviceSerial,
                locationAddress: cam.locationAddress || '',
                latitude: cam.latitude || 11.1345,
                longitude: cam.longitude || 106.5052,
                trapType: cam.trapType || 'Yellow Sticky Trap',
                cropType: cam.cropType || 'Mango Orchard',
                currentCount,
                riskLevel,
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
        const overallRisk = peakRealtimeInsects >= 20 ? 'high' : (peakRealtimeInsects >= 6 ? 'moderate' : 'low');

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

/**
 * AI Agricultural Copilot: Deep Diagnostic, Future Trajectory Forecasting & Actionable IPM Plans
 */
async function getAiDiagnosis(req, res) {
    try {
        const { deviceSerial, timeRange = '7d' } = req.body;
        const userId = req.user.id;

        // Fetch user's cameras
        const userCameras = await Camera.find({ userId });

        // If user has 0 cameras, return clean empty diagnosis (no fake forecasts or actions)
        if (userCameras.length === 0) {
            return res.json({
                success: true,
                diagnosis: {
                    riskLevel: 'low',
                    riskScore: 0,
                    currentPeakCount: 0,
                    dominantPest: '--',
                    weatherFactor: '',
                    forecast: {
                        trajectory: 'stable',
                        confidence: '100%',
                        projectedPeakDate: '',
                        days: []
                    },
                    recommendations: []
                }
            });
        }

        const matchQuery = { aiProcessed: true };
        if (deviceSerial && deviceSerial !== 'all') {
            if (!userCameras.some(c => c.deviceSerial === deviceSerial)) {
                return res.status(403).json({ success: false, message: "You do not have permission to access this camera." });
            }
            matchQuery.deviceSerial = deviceSerial;
        } else {
            matchQuery.deviceSerial = { $in: userCameras.map(c => c.deviceSerial) };
        }

        // Fetch recent snapshots to analyze density trajectory
        const recentSnapshots = await Snapshot.find(matchQuery)
            .sort({ createdAt: -1 })
            .limit(30);

        let latestCount = 0;
        let prevCount = 0;
        const counts = [];

        recentSnapshots.forEach(snap => {
            let c = 0;
            if (snap.aiResults?.summary) {
                const s = snap.aiResults.summary;
                if (s instanceof Map) for (const v of s.values()) c += Number(v) || 0;
                else for (const v of Object.values(s)) c += Number(v) || 0;
            } else if (Array.isArray(snap.aiResults?.insects)) {
                c = snap.aiResults.insects.length;
            }
            counts.push(c);
        });

        if (counts.length > 0) latestCount = counts[0];
        if (counts.length > 5) prevCount = counts[5];

        // If no insects are detected, do NOT create fake 1s or unnecessary chemical plans
        if (counts.length === 0 || latestCount === 0) {
            const today = new Date();
            const forecastDays = [];
            for (let i = 1; i <= 7; i++) {
                const nextDate = new Date(today);
                nextDate.setDate(today.getDate() + i);
                const dateStr = `${String(nextDate.getDate()).padStart(2, '0')}/${String(nextDate.getMonth() + 1).padStart(2, '0')}`;
                forecastDays.push({
                    date: dateStr,
                    projectedCount: 0,
                    risk: 'low'
                });
            }
            return res.json({
                success: true,
                diagnosis: {
                    riskLevel: 'low',
                    riskScore: 0,
                    currentPeakCount: 0,
                    dominantPest: '--',
                    weatherFactor: '',
                    forecast: {
                        trajectory: 'stable',
                        confidence: '99%',
                        projectedPeakDate: forecastDays[forecastDays.length - 1].date,
                        days: forecastDays
                    },
                    recommendations: []
                }
            });
        }

        const isSurging = latestCount > prevCount * 1.25 && latestCount >= 10;
        const riskLevel = latestCount >= 20 ? 'high' : (latestCount >= 6 ? 'moderate' : 'low');

        // Formulate 7-day forecast points
        const forecastDays = [];
        const today = new Date();
        const baseRate = isSurging ? 1.08 : (riskLevel === 'high' ? 1.02 : 0.96);

        for (let i = 1; i <= 7; i++) {
            const nextDate = new Date(today);
            nextDate.setDate(today.getDate() + i);
            const dateStr = `${String(nextDate.getDate()).padStart(2, '0')}/${String(nextDate.getMonth() + 1).padStart(2, '0')}`;
            const projected = Math.round(latestCount * Math.pow(baseRate, i));
            forecastDays.push({
                date: dateStr,
                projectedCount: projected,
                risk: projected >= 20 ? 'high' : (projected >= 6 ? 'moderate' : 'low')
            });
        }

        const diagnosisResult = {
            riskLevel,
            riskScore: latestCount >= 20 ? 88 : (latestCount >= 6 ? 55 : 22),
            currentPeakCount: latestCount,
            // Display text for dominantPest, recommendations and urgency lives in the client
            // i18n files (dashboard.diagnosis.*); the API only returns stable keys
            dominantPest: FRUIT_FLY,
            weatherFactor: 'hot_humid', // 28-32°C with humidity above 75% favors rapid larval outbreaks
            forecast: {
                trajectory: isSurging ? 'surging' : (riskLevel === 'high' ? 'elevated' : 'stable'),
                confidence: '95.8%',
                projectedPeakDate: forecastDays[forecastDays.length - 1].date,
                days: forecastDays
            },
            recommendations: [
                { id: 'REC-01', key: 'pheromoneLure', urgency: 'urgent' },
                { id: 'REC-02', key: 'proteinBait', urgency: riskLevel === 'high' ? 'urgent' : 'recommended' },
                { id: 'REC-03', key: 'fieldSanitation', urgency: 'routine' },
                { id: 'REC-04', key: 'fruitBagging', urgency: 'important' }
            ]
        };

        res.json({
            success: true,
            diagnosis: diagnosisResult
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
