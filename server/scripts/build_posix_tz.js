/**
 * Build server/src/data/posixTz.json: IANA timezone -> POSIX TZ string (what ESP-IDF's
 * setenv("TZ") needs), from Node's own timezone data (ICU) with the current year's rules.
 * Run again after a Node upgrade brings new tzdata: node server/scripts/build_posix_tz.js
 */
const fs = require('fs');
const path = require('path');
const { computePosix } = require('../src/services/timezoneService');

const year = new Date().getUTCFullYear();
// ICU lists its own canonical names (Asia/Saigon, Asia/Calcutta); the IANA names and aliases come
// from countries-and-timezones (Asia/Ho_Chi_Minh, Asia/Kolkata, Europe/Kyiv...)
const zones = [...new Set([...Intl.supportedValuesOf('timeZone'), ...Object.keys(require('countries-and-timezones').getAllTimezones())])];
const table = {};
for (const zone of [...new Set([...zones, 'UTC', 'Etc/UTC'])].sort()) {
    const posix = computePosix(zone, year);
    if (posix) table[zone] = posix;
}
const file = path.join(__dirname, '../src/data/posixTz.json');
fs.writeFileSync(file, JSON.stringify(table, null, 0).replace(/","/g, '",\n"') + '\n');
console.log(`${Object.keys(table).length} zones written to ${file} (rules of ${year}, ICU ${process.versions.icu}, tz ${process.versions.tz})`);
