/**
 * Farm time (Vietnam, UTC+7, no daylight saving) for dates shown in reports and messages.
 */
const FARM_OFFSET_MS = 7 * 60 * 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');
/** 2026-10-14 -> 14/10/2026 */
const dayMonthYear = (key) => `${key.slice(8, 10)}/${key.slice(5, 7)}/${key.slice(0, 4)}`;
/** dd/mm/yyyy hh:mm in farm time */
const farmDateTime = (date) => {
    const d = new Date(new Date(date).getTime() + FARM_OFFSET_MS);
    return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

module.exports = {
    FARM_OFFSET_MS,
    dayMonthYear,
    farmDateTime
};
