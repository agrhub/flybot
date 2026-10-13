const { Farm, Camera } = require('../models');
const notificationService = require('./notificationService');

/**
 * Weather outlook for fruit flies (Bactrocera dorsalis): which of the next days suit them,
 * and a warning to each farm when such days meet the next wave of adults from the
 * degree-day model (services/degreeDayService.js).
 *
 * Adults are most active and lay most around 25-33 °C in humid air; heavy rain keeps them
 * from flying. Those days are common in Vietnam, so they alone only show on the overview:
 * the warning goes out when at least two of them come with a wave of adults due.
 */
const OUTLOOK_DAYS = 3;
const MIN_MEAN = 25;
const MAX_MEAN = 33;
const MIN_HUMIDITY = 70;
const HEAVY_RAIN_MM = 20;
const FAVORABLE_NEEDED = 2;
// A wave due within this many days of the outlook makes it "high"
const WAVE_WINDOW_DAYS = OUTLOOK_DAYS + 2;

const round = (n) => Math.round(n);

/** Does this day suit fruit flies? Unknown humidity or rain do not count against it. */
function favorable(day) {
    const mean = (day.min + day.max) / 2;
    if (mean < MIN_MEAN || mean > MAX_MEAN) return false;
    if (day.humidity !== null && day.humidity !== undefined && day.humidity < MIN_HUMIDITY) return false;
    if (day.rain !== null && day.rain !== undefined && day.rain >= HEAVY_RAIN_MM) return false;
    return true;
}

/**
 * The next OUTLOOK_DAYS forecast days and how much they favor an outbreak:
 * 'high' (favorable days and a wave due), 'elevated' (favorable days), 'low'.
 */
function outlook(temps, nextWave, today) {
    const days = (temps || []).filter(t => t.day > today).slice(0, OUTLOOK_DAYS).map(t => ({
        day: t.day,
        min: round(t.min),
        max: round(t.max),
        humidity: t.humidity === null || t.humidity === undefined ? null : round(t.humidity),
        rain: t.rain === null || t.rain === undefined ? null : Math.round(t.rain * 10) / 10,
        favorable: favorable(t)
    }));
    if (!days.length) return null;
    const favorableDays = days.filter(d => d.favorable).length;
    const waveSoon = !!nextWave && nextWave.inDays <= WAVE_WINDOW_DAYS;
    const level = favorableDays >= FAVORABLE_NEEDED ? (waveSoon ? 'high' : 'elevated') : 'low';
    return { level, favorableDays, waveSoon, days };
}

const dayMonth = (key) => `${key.slice(8, 10)}/${key.slice(5, 7)}`;

/**
 * Evening job: for every farm whose traps have a location, warn the owner and the people it is
 * shared with when the outlook is high. At most one warning per farm a day (cool-down).
 * Returns { farms, warned }.
 */
async function sendWeatherAlerts(now = new Date()) {
    // Loaded here: degreeDayService needs this module for the outlook
    const degreeDayService = require('./degreeDayService');
    const farms = await Farm.find({}).select('name ownerId sharedWith').lean();
    let checked = 0;
    let warned = 0;
    for (const farm of farms) {
        try {
            const cameras = await Camera.find({ farmId: farm._id }).select('deviceSerial deviceName latitude longitude trapKind').lean();
            if (!cameras.some(c => Number.isFinite(c.latitude) && Number.isFinite(c.longitude))) continue;
            const model = await degreeDayService.forCameras(cameras, now);
            checked++;
            const look = model?.outlook;
            if (look?.level !== 'high') continue;
            const good = look.days.filter(d => d.favorable);
            const params = {
                farmName: farm.name,
                farmId: String(farm._id),
                days: good.map(d => dayMonth(d.day)).join(', '),
                minTemp: Math.min(...good.map(d => d.min)),
                maxTemp: Math.max(...good.map(d => d.max)),
                humidity: good.some(d => d.humidity !== null) ? Math.max(...good.filter(d => d.humidity !== null).map(d => d.humidity)) : '--',
                waveDate: dayMonth(model.nextWave.date)
            };
            const recipients = [...new Set([farm.ownerId, ...(farm.sharedWith || []).map(sh => sh.userId)].filter(Boolean).map(String))];
            let sent = false;
            for (const userId of recipients) {
                if (await notificationService.notifyUser({ userId, type: 'weather_risk', deviceSerial: `farm:${farm._id}`, params })) sent = true;
            }
            if (sent) warned++;
        } catch (err) {
            console.error(`⚠️ Weather alert failed (farm ${farm._id}):`, err.message);
        }
    }
    if (warned) console.log(`🌦️ Weather warnings sent for ${warned} farm(s)`);
    return { farms: checked, warned };
}

module.exports = {
    OUTLOOK_DAYS,
    favorable,
    outlook,
    sendWeatherAlerts
};
