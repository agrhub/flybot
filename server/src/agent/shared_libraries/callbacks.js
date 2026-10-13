/**
 * Agent Callbacks - rate limiting and tool execution logging
 * Adapted from BaseFlow backend agent architecture
 */

const requestTimestamps = [];
const RATE_LIMIT_WINDOW_MS = 60000;
const MAX_REQUESTS_PER_WINDOW = 60;

function checkRateLimit() {
    const now = Date.now();
    while (requestTimestamps.length > 0 && requestTimestamps[0] < now - RATE_LIMIT_WINDOW_MS) {
        requestTimestamps.shift();
    }
    if (requestTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
        console.warn('⚠️ [Agent RateLimit] Too many requests, throttling...');
        return false;
    }
    requestTimestamps.push(now);
    return true;
}

function beforeTool(toolName, args) {
    const preview = JSON.stringify(args || {}).substring(0, 100);
    console.log(`[Agent Tool] ▶ ${toolName}(${preview})`);
}

function afterTool(toolName, result, error) {
    if (error) {
        console.error(`[Agent Tool] ✗ ${toolName} FAILED:`, error.message || error);
    } else {
        console.log(`[Agent Tool] ✓ ${toolName} → OK`);
    }
}

module.exports = {
    checkRateLimit,
    beforeTool,
    afterTool
};
