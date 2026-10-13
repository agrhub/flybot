/**
 * Pest risk levels, derived from each camera's own alert threshold (Camera.alertThreshold).
 * This is the single source of truth: the client only displays the levels the API returns.
 */
const DEFAULT_ALERT_THRESHOLD = 15;
const RISK_ORDER = ['low', 'moderate', 'high'];

function thresholdOf(camera) {
    return Number(camera?.alertThreshold) > 0 ? Number(camera.alertThreshold) : DEFAULT_ALERT_THRESHOLD;
}

// "Moderate" starts at a third of the alert threshold (5 for the default 15)
function moderateFloor(threshold) {
    return Math.max(1, Math.round(threshold / 3));
}

function riskLevel(count, threshold = DEFAULT_ALERT_THRESHOLD) {
    if (count >= threshold) return 'high';
    if (count >= moderateFloor(threshold)) return 'moderate';
    return 'low';
}

function worstRisk(levels) {
    return levels.reduce((worst, level) => (RISK_ORDER.indexOf(level) > RISK_ORDER.indexOf(worst) ? level : worst), 'low');
}

module.exports = {
    DEFAULT_ALERT_THRESHOLD,
    thresholdOf,
    moderateFloor,
    riskLevel,
    worstRisk
};
