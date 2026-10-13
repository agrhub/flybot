// Turn the failed tests of a node:test TAP file into GitHub annotations, so a failure can be
// read on the run page (and through the API) without opening the log.
// Usage: node tap-annotations.js <results.tap>
const fs = require('fs');

const [, , file] = process.argv;
if (!file || !fs.existsSync(file)) {
    console.log(`::warning::No test results at ${file}`);
    process.exit(0);
}

const escape = (text) => String(text).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
const lines = fs.readFileSync(file, 'utf8').split('\n');
let failures = 0;

for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*not ok \d+ - (.*)$/);
    if (!match) continue;
    // The YAML block after it: location, error, expected/actual, first stack lines
    const block = [];
    for (let j = i + 1; j < lines.length && !/^\s*(not )?ok \d+ - /.test(lines[j]); j++) block.push(lines[j]);
    const yaml = block.join('\n');
    // Parent subtests repeat their children's failures: report the innermost only
    if (/failureType: 'subtestsFailed'/.test(yaml)) continue;
    failures++;
    const location = (yaml.match(/location: '(.+?):(\d+):\d+'/) || []);
    const file = location[1] ? location[1].replace(/\\\\/g, '/').replace(/^.*?\/(server|client)\//, '$1/') : '';
    // From "error:" up to the stack trace: the message, expected/actual and the diff
    const start = block.findIndex(l => /^\s*error:/.test(l));
    const end = block.findIndex((l, n) => n > start && /^\s*(stack:|\.\.\.$)/.test(l));
    const detail = (start < 0 ? [] : block.slice(start, end < 0 ? undefined : end)).slice(0, 20).map(l => l.trim()).join('\n');
    const where = file ? ` file=${file},line=${location[2]}` : '';
    console.log(`::error${where},title=${escape(match[1]).slice(0, 200)}::${escape(detail || yaml.slice(0, 1500))}`);
}
console.log(`${failures} failed test(s) annotated`);
