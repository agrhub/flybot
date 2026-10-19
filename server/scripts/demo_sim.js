/**
 * The simulated demo farm (services/demoSim.js): labeled synthetic trap photos across Vietnam,
 * analyzed by the real vision pipeline, for visitors such as competition judges. Every command is a
 * dry run (it only prints what it would do) unless --yes is given.
 *
 *   node scripts/demo_sim.js pool <dir>... [--out f] write the photo pool's index (default ./sim-pool.json) from
 *                                                    synthetic sets (flybot-aws data/synth/demo-30d, demo-ahead,
 *                                                    pool: manifest.json, images/, check.jsonl if present) and
 *                                                    print the "aws s3" commands that upload them; no database
 *   node scripts/demo_sim.js pool <dir>... --upload --yes   or upload them through the app's storage settings
 *   node scripts/demo_sim.js apply [--yes]           create the farm and release every photo due until now
 *        [--from YYYY-MM-DD] [--until <ISO date>]    (each one analyzed by the vision Lambda:
 *        [--no-analysis] [--concurrency N]           AI_PROVIDER=opencv-lambda and VISION_LAMBDA_NAME/URL)
 *   node scripts/demo_sim.js remove [--yes]          delete every simulated document and photo, nothing else
 *
 * Idempotent: running apply again only adds what is missing. Visitors see the farm when the admin
 * turns on Admin > System > Demo access > "Show the simulated demo farm"; the daily simulation
 * (same page) keeps adding each day's photos until its end date.
 */
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
    const [command] = args;
    // pool: the set folders, every argument before the first option
    const dirs = [];
    for (const a of args.slice(1)) {
        if (a.startsWith('--')) break;
        dirs.push(a);
    }
    const dryRun = !flag('yes');
    if (!['pool', 'apply', 'remove'].includes(command)) {
        console.log('Usage: node scripts/demo_sim.js pool <dir> | apply | remove [--yes]');
        return 2;
    }
    const demoSim = require('../src/services/demoSim');
    if (command === 'pool') {
        if (!dirs.length) throw new Error('pool needs the synthetic set folders (each with manifest.json).');
        const path = require('path');
        if (flag('upload')) {
            const result = await demoSim.uploadPool({ dirs, dryRun });
            console.log(JSON.stringify({ command, dryRun, ...result }, null, 2));
            if (dryRun) console.log('Dry run: nothing was written. Add --yes to do it.');
            return 0;
        }
        const { index, detected } = demoSim.buildPoolIndex(dirs);
        const out = path.resolve(option('out') || 'sim-pool.json');
        require('fs').writeFileSync(out, JSON.stringify(index));
        console.log(JSON.stringify({ command, poolIndex: out, photos: index.photos.length, detected, traps: index.traps.length }, null, 2));
        console.log('Upload it (bucket = S3_BUCKET_NAME of the server):');
        for (const dir of dirs) {
            console.log(`  aws s3 sync "${path.join(dir, 'images')}" s3://<bucket>/${demoSim.POOL_PREFIX}${path.basename(path.resolve(dir))}/ --exclude "*" --include "*.jpg"`);
        }
        console.log(`  aws s3 cp "${out}" s3://<bucket>/${demoSim.POOL_INDEX} --content-type application/json`);
        return 0;
    }
    const { connectDB } = require('../src/config/db');
    await connectDB();
    let result;
    if (command === 'apply') {
        const env = require('../src/config/env');
        const analyze = !flag('no-analysis');
        if (analyze && !(env.VISION_LAMBDA_URL || env.VISION_LAMBDA_NAME)) throw new Error('The vision Lambda is not configured (VISION_LAMBDA_NAME or VISION_LAMBDA_URL), or pass --no-analysis.');
        const until = option('until') ? new Date(option('until')) : new Date();
        if (Number.isNaN(until.getTime())) throw new Error('--until is not a date.');
        const from = option('from');
        if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error('--from is YYYY-MM-DD.');
        result = await demoSim.simulate({ until, ...(from ? { from } : {}), dryRun, analyze, concurrency: Math.max(1, Math.min(8, parseInt(option('concurrency'), 10) || 4)) });
    } else {
        result = await demoSim.remove({ dryRun });
    }
    console.log(JSON.stringify({ command, dryRun, ...result }, null, 2));
    if (dryRun) console.log('Dry run: nothing was written. Add --yes to do it.');
    return 0;
}

main()
    .then(async (code) => {
        await mongoose.disconnect();
        process.exit(code);
    })
    .catch(async (err) => {
        console.error('❌ demo_sim failed:', err.message);
        await mongoose.disconnect().catch(() => {});
        process.exit(1);
    });
