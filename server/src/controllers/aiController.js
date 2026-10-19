const mongoose = require('mongoose');
const axios = require('axios');
const { Snapshot, Camera } = require('../models');
const aiService = require('../services/aiService');
const s3Service = require('../services/s3Service');
const { sendServerError } = require('../utils/http');
const { viewableCameras, canManageSerial } = require('../utils/ownership');
const { FRUIT_FLY, NON_PEST_LABELS, normalizeSpeciesExpr, isFruitFly } = require('../constants/species');
const { thresholdOf, riskLevel, worstRisk, moderateFloor } = require('../constants/risk');
const { countPests } = require('../services/notificationService');
const forecastService = require('../services/forecastService');
const { latestProcessedByCamera } = require('../services/snapshotQueries');
const dailyStats = require('../services/dailyStats');
const { cardDueAt } = require('../services/maintenanceService');
const weatherService = require('../services/weatherService');
const degreeDayService = require('../services/degreeDayService');
const catchStats = require('../services/catchStats');
const { trapKindOf, isSticky } = require('../constants/trap');

// A day key (YYYY-MM-DD) is a farm day (Asia/Ho_Chi_Minh, UTC+7); anything else is a moment
const DAY_KEY = /^d{4}-d{2}-d{2}$/;
const dayStart = (value) => new Date(DAY_KEY.test(value) ? `${value}T00:00:00+07:00` : value);
const dayEnd = (value) => (DAY_KEY.test(value) ? new Date(`${value}T23:59:59.999+07:00`) : new Date(new Date(value).setHours(23, 59, 59, 999)));

const RISK_LEVELS = ['high', 'moderate', 'low'];
const REVIEW_FILTERS = ['confirmed', 'corrected', 'none', 'requested'];

/**
 * Get AI detection history with pagination.
 * Query:
 *  - deviceSerial: one camera or "all"; deviceSerials: comma-separated cameras (takes precedence)
 *  - startDate, endDate: day range (endDate inclusive)
 *  - risk: high (alarm: at or over the camera threshold) | moderate | low
 *  - review: confirmed | corrected | none | requested (FlyBot Sentinel asked for a check, not reviewed yet)
 * Each result carries deviceName, pestCount, threshold and risk, so the table and exports can
 * show the alarm status of every photo.
 */
async function getAiResults(req, res) {
    try {
        const { deviceSerial } = req.query;
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        // Capped at 500 per page; exports read page after page
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 500);
        const skip = (page - 1) * limit;

        const userCams = await viewableCameras(req.user).select('deviceSerial deviceName alertThreshold').lean();
        const cameraBySerial = new Map(userCams.map(c => [c.deviceSerial, c]));
        const allowedSerials = [...cameraBySerial.keys()];
        if (allowedSerials.length === 0) {
            return res.json({ success: true, total: 0, page, limit, results: [] });
        }

        let serials = allowedSerials;
        const wanted = typeof req.query.deviceSerials === 'string' && req.query.deviceSerials.trim()
            ? [...new Set(req.query.deviceSerials.split(',').map(x => x.trim()).filter(Boolean))]
            : (deviceSerial && deviceSerial !== 'all' ? [deviceSerial] : null);
        if (wanted) {
            if (wanted.some(serial => !cameraBySerial.has(serial))) {
                return res.status(403).json({ success: false, message: "You do not have permission to access this camera." });
            }
            serials = wanted;
        }
        const risk = RISK_LEVELS.includes(req.query.risk) ? req.query.risk : null;
        const review = REVIEW_FILTERS.includes(req.query.review) ? req.query.review : null;

        const matchQuery = { aiProcessed: true, deviceSerial: serials.length === 1 ? serials[0] : { $in: serials } };
        const from = req.query.startDate ? dayStart(req.query.startDate) : null;
        const to = req.query.endDate ? dayEnd(req.query.endDate) : null;
        if (from || to) matchQuery.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
        if (review === 'none') matchQuery['review.status'] = { $exists: false };
        else if (review === 'requested') Object.assign(matchQuery, { 'review.requested.at': { $exists: true }, 'review.status': { $exists: false } });
        else if (review) matchQuery['review.status'] = review;

        const describe = (doc) => {
            const camera = cameraBySerial.get(doc.deviceSerial);
            const threshold = thresholdOf(camera);
            const pestCount = countPests(doc.aiResults?.summary);
            return { ...doc, deviceName: camera?.deviceName || doc.deviceSerial, pestCount, threshold, risk: riskLevel(pestCount, threshold) };
        };

        let total;
        let docs;
        if (!risk) {
            [total, docs] = await Promise.all([
                Snapshot.countDocuments(matchQuery),
                Snapshot.find(matchQuery).sort({ createdAt: -1 }).skip(skip).limit(limit).lean()
            ]);
        } else {
            // The risk depends on each camera's threshold: a pest-count range per camera, on the
            // stored Snapshot.pestCount (filled in for older photos by a startup migration)
            const { createdAt, ...base } = matchQuery;
            delete base.deviceSerial;
            const rangeOf = (camera) => {
                const threshold = thresholdOf(camera);
                const floor = moderateFloor(threshold);
                if (risk === 'high') return { $gte: threshold };
                if (risk === 'moderate') return { $gte: floor, $lt: threshold };
                return { $lt: floor };
            };
            const filter = {
                ...base,
                $or: serials.map(serial => ({ deviceSerial: serial, ...(createdAt ? { createdAt } : {}), pestCount: rangeOf(cameraBySerial.get(serial)) }))
            };
            // find + countDocuments rather than $facet: a page of full snapshots can pass 16 MB
            [total, docs] = await Promise.all([
                Snapshot.countDocuments(filter),
                Snapshot.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean()
            ]);
        }

        res.json({ success: true, total, page, limit, results: docs.map(describe) });
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
            startDate = dayStart(customStart);
            if (customEnd) endDate = dayEnd(customEnd);
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
            // Insects caught per day (rise of each card) instead of the count on the cards
            if (req.query.metric === 'catches') {
                const end = endDate || new Date();
                const spanDays = Math.max(1, Math.ceil((end - startDate) / 86400000) + 1);
                const data = await catchStats.catchesBySerial(serials, Math.min(spanDays, 400), end);
                return res.json({
                    success: true,
                    mode: mode || 'day',
                    metric: 'catches',
                    deviceSerial: deviceSerial || 'all',
                    data: catchStats.speciesCatchSeries(data, mode === 'month' ? 'month' : 'day')
                });
            }
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
        // Farm names, for the dashboard card's farm filter
        const farmIds = [...new Set(dedupedCameras.map(c => c.farmId).filter(Boolean).map(String))];
        const farmNames = new Map(farmIds.length
            ? (await require('../models').Farm.find({ _id: { $in: farmIds } }).select('name').lean()).map(f => [String(f._id), f.name])
            : []);
        let peakRealtimeInsects = 0;
        let peakCamera = null;
        let totalRealtimeInsects = 0;
        // Lure traps are judged by today's average per photo, as their threshold alert is
        const lureSerials = dedupedCameras.filter(c => trapKindOf(c) === 'lure').map(c => c.deviceSerial);
        const todayKey = dailyStats.dayKeyOf(new Date());
        const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
        // Independent reads, at the same time: the dashboard waits for the slowest one only
        const [latestByCamera, lureRows, statsDay, rollup30, totalSnapshots, catches] = await Promise.all([
            latestProcessedByCamera(cameraSerials),
            dailyStats.rows(lureSerials, todayKey, todayKey),
            // Last 24 h from snapshots (rolling window); 7 and 30 days from the daily rollup
            computePeriodStats({ ...matchQuery, createdAt: { $gte: last24h } }),
            dailyStats.rows(cameraSerials, dailyStats.startKeyForDays(30)),
            // From the rollup: counting every photo grows with the history
            dailyStats.scanCount(cameraSerials),
            // Catches: insects that arrived per day (rise of each card), the figure to act on
            catchStats.overview(cameraSerials)
        ]);
        const lureAverage = new Map(lureRows.filter(r => r.scans).map(r => [r.deviceSerial, Math.round((r.total / r.scans) * 10) / 10]));

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
            const lure = trapKindOf(cam) === 'lure';
            const riskValue = lure ? (lureAverage.get(cam.deviceSerial) ?? 0) : currentCount;
            const camRisk = riskLevel(riskValue, alertThreshold);

            cameraRealtimeList.push({
                deviceSerial: cam.deviceSerial,
                deviceName: cam.deviceName || cam.deviceSerial,
                locationAddress: cam.locationAddress || '',
                farmId: cam.farmId ? String(cam.farmId) : null,
                farmName: cam.farmId ? farmNames.get(String(cam.farmId)) || null : null,
                ...(cam.simulated ? { simulated: true } : {}),
                // null when the trap has no GPS position yet (never a made-up default)
                latitude: Number.isFinite(cam.latitude) ? cam.latitude : null,
                longitude: Number.isFinite(cam.longitude) ? cam.longitude : null,
                trapType: cam.trapType || 'Yellow Sticky Trap',
                trapKind: trapKindOf(cam),
                cropType: cam.cropType || 'Mango Orchard',
                currentCount,
                // What the threshold is compared with: today's average per photo on a lure trap
                riskValue,
                riskBasis: lure ? 'dailyAverage' : 'latest',
                riskLevel: camRisk,
                alertThreshold,
                status: cam.status ?? 1,
                lastScanTime,
                lastImageUrl,
                // The latest analyzed photo with its detections, for the annotated preview
                latestSnapshot: latestSnapshot ? {
                    _id: latestSnapshot.snapshotId,
                    deviceSerial: cam.deviceSerial,
                    createdAt: latestSnapshot.createdAt,
                    imageUrl: latestSnapshot.imageUrl || '',
                    s3Key: latestSnapshot.s3Key || '',
                    aiResults: { summary: latestSnapshot.summary || {}, insects: latestSnapshot.insects || [] }
                } : null,
                // Sticky card reminder date (null when reminders are off)
                cardDueAt: cardDueAt(cam)
            });
        }

        // 2. Real historical stats (Min, Max, Avg, totalScans) for Day (24h), Week (7d), Month (30d)
        const rollup7 = rollup30.filter(r => r.day >= dailyStats.startKeyForDays(7));
        const statsWeek = rollupPeriodStats(rollup7);
        const statsMonth = rollupPeriodStats(rollup30);

        // 3. Processed photos in the last 24 h (the day's stats counted them)
        const last24hCount = statsDay.totalScans || 0;

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

        // 5. Catches per camera
        for (const row of cameraRealtimeList) {
            Object.assign(row, catches.perCamera[row.deviceSerial] || {});
            const cam = cameraMap.get(row.deviceSerial);
            const since = cam?.cardReplacedAt || null;
            row.cardAgeDays = since ? Math.floor((Date.now() - new Date(since).getTime()) / 86400000) : null;
        }
        // Past 7 days of catches (all cameras), for the trend line
        const trendAgg = catches.series14.slice(-7).map(({ day, total }) => {
            const [, m, d] = day.split('-');
            return { _id: `${d}/${m}`, count: total };
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
                trend7Days: trendAgg,
                catches: {
                    today: catches.today,
                    yesterday: catches.yesterday,
                    last7: catches.last7,
                    prev7: catches.prev7,
                    ftd7: catches.ftd7,
                    ftdPrev7: catches.ftdPrev7,
                    changePct: catches.changePct,
                    periods: catches.periods,
                    series14: catches.series14
                }
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
        // The forecast follows the most loaded trap, against its own threshold
        const referenceThreshold = peak.threshold;
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

        // Trend of the most loaded trap's daily catches (a card's count only grows, so its own
        // trend says nothing); the forecast adds them to what is on the card now (no card change)
        const { dayKeys: catchKeys, cameras: catchMap } = await catchStats.catchesBySerial([peak.cam.deviceSerial], HISTORY_DAYS, now);
        const peakCatches = catchMap.get(peak.cam.deviceSerial).total;
        const points = catchKeys
            .map((day, dayIndex) => ({ dayIndex, value: peakCatches.get(day) }))
            .filter(p => p.value !== null && p.value !== undefined);
        const hasDetections = peak.count > 0 || points.some(p => p.value > 0) || daily.some(d => d.peak > 0);

        const trend = forecastService.forecast(points, HISTORY_DAYS, FORECAST_DAYS);
        // Sticky: catches pile up on the card. Lure: each day stands alone (flies present)
        const sticky = isSticky(peak.cam);
        let onCard = peak.count;
        const forecastDays = trend.projected.map((catches, i) => {
            onCard = sticky ? onCard + catches : catches;
            return {
                date: dayLabel(new Date(now.getTime() + (i + 1) * 86400000)),
                projectedCount: onCard,
                projectedCatches: catches,
                risk: riskLevel(onCard, peak.threshold)
            };
        });

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
                trapKind: trapKindOf(peak.cam),
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
        // Optional: only some of my cameras (comma-separated serials)
        const wanted = typeof req.query.deviceSerials === 'string' && req.query.deviceSerials.trim()
            ? new Set(req.query.deviceSerials.split(',').map(x => x.trim()).filter(Boolean))
            : null;
        const cameras = [...bySerial.values()].filter(c => !wanted || wanted.has(c.deviceSerial));

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

        // Whole local days: "last 7 days" = today and the 6 days before it.
        // totalInsects = insects caught (rise of each card), avgPerScan = flies per trap per day (FTD)
        const serials = cameras.map(c => c.deviceSerial);
        const [{ dayKeys, cameras: catchMap }, rollup] = await Promise.all([
            catchStats.catchesBySerial(serials, 2 * days),
            dailyStats.rows(serials, dailyStats.startKeyForDays(2 * days))
        ]);
        const currentKeys = dayKeys.slice(-days);
        const previousKeys = dayKeys.slice(0, dayKeys.length - days);
        const currentKey = currentKeys[0];
        const scansOf = (list) => list.reduce((s, r) => s + r.scans, 0);
        const peakOf = (list) => list.reduce((m, r) => Math.max(m, r.peak || 0), 0);

        const summarize = (entries, keys, rows) => {
            const c = catchStats.summarize(entries, keys);
            return { totalInsects: c.total, scans: scansOf(rows), avgPerScan: c.ftd ?? 0, peakCount: peakOf(rows), trapDays: c.trapDays };
        };
        const curRows = rollup.filter(r => r.day >= currentKey);
        const prevRows = rollup.filter(r => r.day < currentKey);
        const allEntries = [...catchMap.values()];
        const current = { start: currentStart, end: now, ...summarize(allEntries, currentKeys, curRows) };
        const previous = { start: previousStart, end: currentStart, ...summarize(allEntries, previousKeys, prevRows) };

        const cameraRows = cameras.map(cam => {
            const one = [catchMap.get(cam.deviceSerial)];
            const cur = summarize(one, currentKeys, curRows.filter(r => r.deviceSerial === cam.deviceSerial));
            const prev = summarize(one, previousKeys, prevRows.filter(r => r.deviceSerial === cam.deviceSerial));
            return {
                deviceSerial: cam.deviceSerial,
                deviceName: cam.deviceName || cam.deviceSerial,
                alertThreshold: thresholdOf(cam),
                ...cur,
                // Risk of the period's highest card count against this camera's threshold
                riskLevel: riskLevel(cur.peakCount, thresholdOf(cam)),
                previousTotal: prev.totalInsects,
                changePct: cur.trapDays && prev.trapDays ? percentChange(cur.totalInsects, prev.totalInsects) : null
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

/**
 * GET /api/ai/insights?deviceSerial=all&days=14
 * Analytics, Insights tab: per-trap table, daily catches per trap, catches by hour of day,
 * and daily temperatures next to catches.
 */
async function getAiInsights(req, res) {
    try {
        const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 7), 30);
        const all = await viewableCameras(req.user).lean();
        let cameras = [...new Map(all.map(c => [c.deviceSerial, c])).values()];
        if (req.query.deviceSerial && req.query.deviceSerial !== 'all') {
            cameras = cameras.filter(c => c.deviceSerial === req.query.deviceSerial);
            if (!cameras.length) return res.status(403).json({ success: false, message: "You do not have permission to access this camera." });
        }
        if (!cameras.length) return res.json({ success: true, insights: { days: [], traps: [], activity: null, weather: null } });
        const serials = cameras.map(c => c.deviceSerial);

        const { Farm, Plot } = require('../models');
        const [catches, latest, activity, plots, farms] = await Promise.all([
            catchStats.catchesBySerial(serials, days),
            latestProcessedByCamera(serials),
            catchStats.activityByHour(serials, Math.min(days, 14)),
            Plot.find({ _id: { $in: cameras.map(c => c.plotId).filter(Boolean) } }).select('name farmId').lean(),
            Farm.find({ _id: { $in: cameras.map(c => c.farmId).filter(Boolean) } }).select('name').lean()
        ]);
        const plotName = new Map(plots.map(p => [String(p._id), p.name]));
        const farmName = new Map(farms.map(f => [String(f._id), f.name]));
        const keys = catches.dayKeys;
        const half = Math.min(7, Math.floor(keys.length / 2));

        const traps = cameras.map(cam => {
            const byDay = catches.cameras.get(cam.deviceSerial).total;
            const one = [{ total: byDay }];
            const recent = catchStats.summarize(one, keys.slice(-half));
            const before = catchStats.summarize(one, keys.slice(-2 * half, -half));
            const snap = latest.get(cam.deviceSerial);
            const onCard = snap ? countPests(snap.summary instanceof Map ? Object.fromEntries(snap.summary) : snap.summary) : 0;
            return {
                deviceSerial: cam.deviceSerial,
                deviceName: cam.deviceName || cam.deviceSerial,
                plot: cam.plotId ? plotName.get(String(cam.plotId)) || null : null,
                farm: cam.farmId ? farmName.get(String(cam.farmId)) || null : null,
                online: cam.status === 1,
                trapKind: trapKindOf(cam),
                onCard,
                alertThreshold: thresholdOf(cam),
                riskLevel: riskLevel(onCard, thresholdOf(cam)),
                today: byDay.get(keys.at(-1)) ?? null,
                total: catchStats.summarize(one, keys).total,
                ftd: recent.ftd,
                changePct: recent.trapDays && before.trapDays ? catchStats.percentChange(recent.total, before.total) : null,
                cardAgeDays: cam.cardReplacedAt ? Math.floor((Date.now() - new Date(cam.cardReplacedAt).getTime()) / 86400000) : null,
                lastScanAt: snap?.createdAt || null,
                imageIssues: cam.imageQuality?.issues || [],
                daily: keys.map(day => byDay.get(day) ?? null)
            };
        }).sort((a, b) => (b.ftd ?? -1) - (a.ftd ?? -1));

        // Daily min/max temperature at the first trap with GPS (Open-Meteo, cached)
        let weather = null;
        const located = cameras.find(c => Number.isFinite(c.latitude) && Number.isFinite(c.longitude));
        if (located) {
            const temps = await weatherService.getDailyTemperatures(located.latitude, located.longitude).catch(() => null);
            if (temps) {
                const byDay = new Map(temps.map(t => [t.day, t]));
                weather = keys.map(day => ({ day, min: byDay.get(day)?.min ?? null, max: byDay.get(day)?.max ?? null }));
            }
        }

        res.json({ success: true, insights: { days: keys, traps, activity, weather } });
    } catch (err) {
        sendServerError(res, err, { context: 'AI insights' });
    }
}

const agent = require('../agent/agent');
const MAX_CHAT_MESSAGE = 4000;
const MAX_UI_CONTEXT = 8000;

// Chat session ids come from the browser: short, plain
const SESSION_ID_REGEX = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Check a chat request body. Returns { message, sessionId, uiContext } or { error }.
 */
function readChatRequest(body = {}) {
    const { message, sessionId = 'default-session', uiContext = {} } = body;
    if (typeof message !== 'string' || !message.trim()) return { error: "Message cannot be empty." };
    // Everything here goes into the model prompt: keep it small
    if (message.length > MAX_CHAT_MESSAGE) return { error: `Message is too long (at most ${MAX_CHAT_MESSAGE} characters).` };
    if (JSON.stringify(uiContext ?? {}).length > MAX_UI_CONTEXT) return { error: "Page context is too large." };
    if (!SESSION_ID_REGEX.test(String(sessionId))) return { error: "Invalid chat session." };
    return { message, sessionId: String(sessionId), uiContext: uiContext && typeof uiContext === 'object' ? uiContext : {} };
}

// The guest account (services/guestAccess.js) is shared: each guest session keeps its own chats
const chatIdOf = (req, id) => (req.user?.guest && req.sessionId ? require('../services/guestAccess').guestChatSession(req.sessionId, id) : id);

// The answer as the panel gets it (tool data stays on the server)
const chatPayload = (result) => ({
    reply: result.reply,
    suggestions: result.suggestions,
    navigate: result.navigate,
    actions: result.actions,
    cards: result.cards || [],
    messageId: result.messageId,
    toolExecutions: (result.toolExecutions || []).map(run => ({ name: run.name, status: run.status, result: { message: run.message } }))
});

/**
 * POST /api/ai/chat: AI agent with function tools; the whole answer at once
 */
async function chatWithAssistant(req, res) {
    try {
        const input = readChatRequest(req.body);
        if (input.error) return res.status(400).json({ success: false, message: input.error });
        const result = await agent.chatWithAgent({ ...input, sessionId: chatIdOf(req, input.sessionId), userId: req.user.id, user: req.user });
        res.json({ success: true, ...chatPayload(result) });
    } catch (err) {
        console.error("❌ AI Agent chat error:", err);
        sendServerError(res, err);
    }
}

/**
 * POST /api/ai/chat/stream: the same, as server-sent events while it is written:
 * turn, delta { text }, tool { name, phase, status?, message? }, then done { ...answer } or error
 */
async function chatWithAssistantStream(req, res) {
    const input = readChatRequest(req.body);
    if (input.error) return res.status(400).json({ success: false, message: input.error });
    res.status(200).set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    let open = true;
    req.on('close', () => { open = false; });
    const send = (event, data) => {
        if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // Proxies close quiet connections: a comment line now and then while tools run
    const heartbeat = setInterval(() => { if (open) res.write(': keep-alive\n\n'); }, 15000);
    try {
        const result = await agent.chatWithAgent({ ...input, sessionId: chatIdOf(req, input.sessionId), userId: req.user.id, user: req.user, onEvent: send });
        send('done', chatPayload(result));
    } catch (err) {
        console.error("❌ AI Agent chat error:", err.message);
        send('error', { message: require('../utils/i18n').translate(req.user?.language, 'assistant.error') });
    } finally {
        clearInterval(heartbeat);
        res.end();
    }
}

/**
 * GET /api/ai/chat/history?sessionId=: the conversation, to show again after a reload
 */
async function getChatHistory(req, res) {
    try {
        const sessionId = String(req.query.sessionId || '');
        if (!SESSION_ID_REGEX.test(sessionId)) return res.status(400).json({ success: false, message: "Invalid chat session." });
        res.json({ success: true, messages: await agent.getChatHistory(req.user.id, chatIdOf(req, sessionId)) });
    } catch (err) {
        sendServerError(res, err);
    }
}

/**
 * POST /api/ai/chat/feedback { sessionId, messageId, rating: 'up' | 'down' | null }
 */
async function rateChatMessage(req, res) {
    try {
        const { sessionId, messageId, rating = null } = req.body || {};
        if (!SESSION_ID_REGEX.test(String(sessionId || '')) || typeof messageId !== 'string' || ![null, 'up', 'down'].includes(rating)) {
            return res.status(400).json({ success: false, message: "Invalid rating." });
        }
        const found = await agent.rateMessage(req.user.id, chatIdOf(req, String(sessionId)), messageId.slice(0, 100), rating);
        if (!found) return res.status(404).json({ success: false, message: "Message not found." });
        res.json({ success: true, rating });
    } catch (err) {
        sendServerError(res, err);
    }
}

/** The camera of a confirmed card, if the person may manage it. */
async function manageable(req, payload) {
    const { findManageableCamera } = require('../utils/ownership');
    const camera = await findManageableCamera(req.user, String(payload.deviceSerial || ''));
    return camera || { error: "Camera not found or you cannot manage it." };
}

const CONFIRM_ACTIONS = {
    // A sticky card replaced: the same checks as POST /api/user/camera/maintenance
    async card_change(req, payload) {
        const { findManageableCamera } = require('../utils/ownership');
        const camera = await findManageableCamera(req.user, String(payload.deviceSerial || ''));
        if (!camera) return { error: "Camera not found or you cannot manage it." };
        const at = new Date(payload.at);
        if (isNaN(at) || at > new Date(Date.now() + 5 * 60 * 1000) || at < new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)) {
            return { error: "Invalid date (up to 90 days back, not in the future)." };
        }
        await require('../services/maintenanceService').recordEvent({ deviceSerial: camera.deviceSerial, type: 'card_replaced', at, note: payload.note || '', user: req.user });
        return {};
    },
    // ---- Actions the vision Lambda and the chatbot propose (services/sentinelService.js checkAction) ----
    // An extra photo now (the Sentinel capture budget does not apply: a person confirmed it)
    async capture_now(req, payload) {
        const camera = await manageable(req, payload);
        if (camera.error) return camera;
        const { captureAndSaveSnapshot } = require('../cron/captureJob');
        const saved = await captureAndSaveSnapshot(camera.deviceSerial, { trigger: 'sentinel' });
        if (!saved) {
            // A CamOS camera on battery takes the photo at its next wake (the request is in its shadow)
            if (camera.platform === 'camos') {
                const status = await require('../platforms').get(camera).getStatus(camera.deviceSerial).catch(() => null);
                if (status && (status.sleeping || !status.online)) return { message: 'The camera is asleep: it will take the photo at its next wake.' };
            }
            return { error: 'The camera did not return an image. It may be offline.' };
        }
        return { message: `Photo ${saved._id} stored.` };
    },
    // A faster (or slower) capture interval for 24 hours, and the camera's own schedule for CamOS
    async set_interval(req, payload) {
        const camera = await manageable(req, payload);
        if (camera.error) return camera;
        const { CAPTURE_INTERVALS } = require('../services/captureSchedule');
        const minutes = Number(payload.minutes);
        if (!CAPTURE_INTERVALS.includes(minutes)) return { error: `minutes must be one of ${CAPTURE_INTERVALS.join(', ')}.` };
        const now = new Date();
        await Camera.updateOne({ _id: camera._id }, { $set: { sentinelInterval: { minutes, until: new Date(now.getTime() + 24 * 3600 * 1000), setAt: now, reason: String(payload.reason || 'confirmed proposal').slice(0, 300) } } });
        if (camera.platform === 'camos') {
            await require('../platforms').get(camera).setCaptureSchedule(camera.deviceSerial, minutes)
                .catch(err => console.warn(`⚠️ Shadow interval not set (${camera.deviceSerial}): ${err.message}`));
        }
        require('../services/auditService').recordAudit(req, { action: 'sentinel.capture_interval', target: { type: 'camera', id: camera.deviceSerial, label: camera.deviceName }, details: { minutes, hours: 24, via: 'card' } });
        return { message: `Every ${minutes} minutes for 24 hours.` };
    },
    // Image settings of a CamOS camera (shadow desired video.image)
    async set_isp(req, payload) {
        const camera = await manageable(req, payload);
        if (camera.error) return camera;
        if (camera.platform !== 'camos') return { error: 'Image settings can only be changed on a CamOS camera.' };
        const image = {};
        if (payload.brightness !== undefined) image.brightness = Number(payload.brightness);
        if (payload.wdr !== undefined) image.wdr = typeof payload.wdr === 'boolean' ? (payload.wdr ? 2 : 0) : Number(payload.wdr);
        if (!Object.keys(image).length) return { error: 'Nothing to change.' };
        await require('../platforms/camos').updateDesired(camera.deviceSerial, { video: { image } });
        return { message: `Image settings sent: ${Object.entries(image).map(([k, v]) => `${k}=${v}`).join(', ')}.` };
    },
    // A person's review of the photo (the same flag as POST /api/sentinel/review-request)
    async review_request(req, payload) {
        const camera = await manageable(req, payload);
        if (camera.error) return camera;
        const { Snapshot } = require('../models');
        const now = new Date();
        const snapshot = payload.snapshotId && require('mongoose').isValidObjectId(payload.snapshotId)
            ? await Snapshot.findOne({ _id: payload.snapshotId, deviceSerial: camera.deviceSerial }).select('_id review').lean()
            : await Snapshot.findOne({ deviceSerial: camera.deviceSerial }).sort({ createdAt: -1 }).select('_id review').lean();
        if (!snapshot) return { error: 'Photo not found.' };
        if (snapshot.review?.status) return { message: 'This photo was already reviewed.' };
        await Snapshot.updateOne({ _id: snapshot._id, 'review.requested': { $exists: false } }, { $set: { 'review.requested': { at: now, reason: String(payload.reason || 'Sentinel asked for a check').slice(0, 300), by: 'sentinel' } } });
        return { message: 'Marked for review in the photo history.' };
    },
    // A message in the owner's notification feed (and their channels)
    async notify(req, payload) {
        const camera = await manageable(req, payload);
        if (camera.error) return camera;
        const message = String(payload.message || '').trim().slice(0, 500);
        if (!message) return { error: 'Nothing to send.' };
        await require('../services/notificationService').notifyUser({
            userId: req.user.id,
            type: 'review_requested',
            deviceSerial: camera.deviceSerial,
            params: { deviceName: camera.deviceName || camera.deviceSerial, reason: message, snapshotId: payload.snapshotId ? String(payload.snapshotId) : '' }
        });
        return { message: 'Sent.' };
    },
    // A logbook treatment: the same checks as POST /api/treatments
    async treatment(req, payload) {
        const { Treatment } = require('../models');
        const { validateInput } = require('./treatmentController');
        const checked = await validateInput(payload, req.user);
        if (checked.error) return { error: checked.error };
        const treatment = await Treatment.create({ ...checked.value, createdBy: req.user.id, createdByEmail: req.user.email });
        require('../services/auditService').recordAudit(req, {
            action: 'treatment.created',
            target: { type: 'treatment', id: String(treatment._id), label: `${treatment.type}${treatment.product ? `: ${treatment.product}` : ''}` },
            details: { cameras: treatment.cameraSerials, at: treatment.at.toISOString(), via: 'assistant' }
        });
        return {};
    }
};

/**
 * Confirm or cancel one stored confirm card of `user`: the endpoint below, and the Telegram
 * buttons of a FlyBot Sentinel proposal (services/sentinelService.js). The card is claimed
 * once (a double click, a second tab or Telegram cannot run it twice); a card past its
 * `expiresAt` ends as 'expired' without running. Returns { status, body } for the HTTP answer.
 */
async function decideCard({ user, sessionId, messageId, cardIndex, decision, req = null, via = 'app' }) {
    const actionReq = req || { user, ip: '', headers: { 'user-agent': `FlyBot ${via}` } };
    const userId = user.id;
    const card = await agent.claimCard(userId, sessionId, messageId, cardIndex, decision === 'cancel' ? 'cancelled' : 'running');
    if (!card) return { status: 409, body: { success: false, message: "This has already been handled." } };

    let state;
    let message = '';
    if (card.expiresAt && new Date(card.expiresAt) <= new Date()) {
        state = 'expired';
        message = "This proposal has expired.";
        await agent.finishCard(userId, sessionId, messageId, cardIndex, { state, message });
    } else if (decision === 'cancel') {
        state = 'cancelled';
    } else {
        const run = CONFIRM_ACTIONS[card.action];
        const outcome = run ? await run(actionReq, card.payload || {}).catch(err => ({ error: err.message })) : { error: "Unknown action." };
        state = outcome.error ? 'failed' : 'done';
        message = outcome.error || '';
        await agent.finishCard(userId, sessionId, messageId, cardIndex, { state, message });
    }
    if (card.proposalId) {
        await require('../services/sentinelService').recordDecision(card.proposalId, { state, message, via, req: actionReq })
            .catch(err => console.error('⚠️ Sentinel proposal state not saved:', err.message));
    }
    if (state === 'expired') return { status: 410, body: { success: false, state, message } };
    if (state === 'failed') return { status: 400, body: { success: false, state, message } };
    return { status: 200, body: { success: true, state } };
}

/**
 * POST /api/ai/chat/confirm { sessionId, messageId, cardIndex, decision: 'confirm' | 'cancel' }
 * Runs (or drops) a change the assistant (or FlyBot Sentinel, session "sentinel") proposed, from
 * the card stored with its answer: what the browser sends is only which card, never what to record.
 */
async function confirmChatAction(req, res) {
    try {
        const { sessionId, messageId, cardIndex, decision } = req.body || {};
        if (!SESSION_ID_REGEX.test(String(sessionId || '')) || typeof messageId !== 'string'
            || !Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex > 9 || !['confirm', 'cancel'].includes(decision)) {
            return res.status(400).json({ success: false, message: "Invalid request." });
        }
        const { status, body } = await decideCard({ user: req.user, sessionId, messageId: messageId.slice(0, 100), cardIndex, decision, req, via: 'app' });
        res.status(status).json(body);
    } catch (err) {
        sendServerError(res, err, { context: 'Confirm assistant action' });
    }
}

async function clearChatSession(req, res) {
    try {
        const { sessionId = 'default-session' } = req.body || {};
        if (!SESSION_ID_REGEX.test(String(sessionId))) return res.status(400).json({ success: false, message: "Invalid chat session." });
        await agent.clearChatHistory(req.user.id, chatIdOf(req, String(sessionId)));
        res.json({ success: true, message: "Chat session refreshed successfully." });
    } catch (err) {
        sendServerError(res, err);
    }
}

module.exports = {
    getAiInsights,
    getAiResults,
    analyzeRoboflowSnapshot,
    getAiStatistics,
    getAiOverview,
    getAiDiagnosis,
    getAiComparison,
    reviewSnapshot,
    exportReviews,
    chatWithAssistant,
    chatWithAssistantStream,
    getChatHistory,
    rateChatMessage,
    confirmChatAction,
    decideCard,
    clearChatSession
};
