/**
 * Decides which cameras are due for an automatic snapshot.
 * The scheduler ticks every few minutes; each device is captured when its interval has passed.
 */
const TIMEZONE = 'Asia/Ho_Chi_Minh';
const CAPTURE_INTERVALS = [15, 30, 60, 120];
const DEFAULT_INTERVAL = 30;
const DAYTIME_START_HOUR = 6;
const DAYTIME_END_HOUR = 18;
// Ticks are not exact; treat a device as due slightly early so it is not pushed a whole tick late
const TOLERANCE_MS = 2 * 60 * 1000;

function localHour(date) {
    return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', hour12: false }).format(date)) % 24;
}

function isDaytime(date) {
    const hour = localHour(date);
    return hour >= DAYTIME_START_HOUR && hour < DAYTIME_END_HOUR;
}

/**
 * Merge the settings of every user who has the same device:
 * the most frequent interval wins, and night capture is skipped only if everyone opted out.
 * @returns Map<deviceSerial, { intervalMinutes, daytimeOnly, lastCaptureAt }>
 */
function deviceSchedules(cameras) {
    const devices = new Map();
    for (const cam of cameras) {
        const interval = CAPTURE_INTERVALS.includes(cam.captureIntervalMinutes) ? cam.captureIntervalMinutes : DEFAULT_INTERVAL;
        const current = devices.get(cam.deviceSerial);
        const last = cam.lastCaptureAt ? new Date(cam.lastCaptureAt) : null;
        if (!current) {
            devices.set(cam.deviceSerial, { intervalMinutes: interval, daytimeOnly: !!cam.captureDaytimeOnly, lastCaptureAt: last });
        } else {
            current.intervalMinutes = Math.min(current.intervalMinutes, interval);
            current.daytimeOnly = current.daytimeOnly && !!cam.captureDaytimeOnly;
            if (last && (!current.lastCaptureAt || last > current.lastCaptureAt)) current.lastCaptureAt = last;
        }
    }
    return devices;
}

/**
 * Serial numbers due for capture at `now`.
 */
function dueSerials(cameras, now = new Date()) {
    const due = [];
    for (const [serial, schedule] of deviceSchedules(cameras)) {
        if (schedule.daytimeOnly && !isDaytime(now)) continue;
        const elapsed = schedule.lastCaptureAt ? now - schedule.lastCaptureAt : Infinity;
        if (elapsed >= schedule.intervalMinutes * 60 * 1000 - TOLERANCE_MS) due.push(serial);
    }
    return due;
}

module.exports = {
    TIMEZONE,
    CAPTURE_INTERVALS,
    DEFAULT_INTERVAL,
    isDaytime,
    deviceSchedules,
    dueSerials
};
