/**
 * Short-term pest trend forecast from daily peak counts.
 *
 * A least-squares line through the days that have data. Deliberately simple and honest:
 * confidence comes from how many days we have and how well the line fits (R²),
 * not from a fixed number.
 */
const MIN_DAYS_FOR_TREND = 3;
// Relative daily change (slope / mean) above which the trend counts as rising or falling
const TREND_THRESHOLD = 0.08;

/**
 * @param {Array<{ dayIndex: number, value: number }>} points  dayIndex 0 = oldest day in the window
 * @returns {{ slope, intercept, r2, n, mean }}
 */
function linearFit(points) {
    const n = points.length;
    if (n === 0) return { slope: 0, intercept: 0, r2: 0, n, mean: 0 };
    const meanX = points.reduce((s, p) => s + p.dayIndex, 0) / n;
    const meanY = points.reduce((s, p) => s + p.value, 0) / n;
    if (n === 1) return { slope: 0, intercept: meanY, r2: 0, n, mean: meanY };

    let sxx = 0, sxy = 0, syy = 0;
    for (const p of points) {
        sxx += (p.dayIndex - meanX) ** 2;
        sxy += (p.dayIndex - meanX) * (p.value - meanY);
        syy += (p.value - meanY) ** 2;
    }
    const slope = sxx === 0 ? 0 : sxy / sxx;
    const intercept = meanY - slope * meanX;
    // A flat series is perfectly explained by a flat line
    const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
    return { slope, intercept, r2, n, mean: meanY };
}

function confidenceLevel(n, r2) {
    if (n < MIN_DAYS_FOR_TREND) return 'low';
    if (n >= 7 && r2 >= 0.6) return 'high';
    if (n >= 5 && r2 >= 0.3) return 'medium';
    return 'low';
}

function trajectoryOf(fit) {
    if (fit.n < MIN_DAYS_FOR_TREND || fit.mean === 0) return 'stable';
    const relative = fit.slope / fit.mean;
    if (relative > TREND_THRESHOLD) return 'surging';
    if (relative < -TREND_THRESHOLD) return 'declining';
    return 'stable';
}

/**
 * @param {Array<{ dayIndex: number, value: number }>} points  daily peaks inside the window
 * @param {number} windowDays  length of the history window (the next day is index windowDays)
 * @param {number} horizon     days to project
 */
function forecast(points, windowDays, horizon = 7) {
    const fit = linearFit(points);
    const lastValue = points.length ? points[points.length - 1].value : 0;
    const projected = [];
    for (let i = 1; i <= horizon; i++) {
        // Without enough history, carry the latest value forward instead of extrapolating noise
        const value = fit.n >= MIN_DAYS_FOR_TREND
            ? fit.intercept + fit.slope * (windowDays - 1 + i)
            : lastValue;
        projected.push(Math.max(0, Math.round(value)));
    }
    return {
        projected,
        trajectory: trajectoryOf(fit),
        confidence: confidenceLevel(fit.n, fit.r2),
        dataDays: fit.n,
        r2: Math.round(fit.r2 * 100) / 100
    };
}

module.exports = {
    MIN_DAYS_FOR_TREND,
    linearFit,
    confidenceLevel,
    trajectoryOf,
    forecast
};
