// Pictures in a .pptx that Google Slides (and so Google Drive's preview) cannot show, WebP and
// SVG, turned into PNG. Uses headless Chrome to decode them (cdp.mjs), no image library needed.
// Usage: node pptx-images.mjs <in.pptx> <out.pptx>   (also used by prepare-deck-pptx.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { unzipSync, zipSync, strFromU8, strToU8 } = require(require.resolve('fflate', { paths: [path.join(here, '../..')] }));

const MIME = { webp: 'image/webp', svg: 'image/svg+xml' };

/** Convert the WebP and SVG pictures of an unzipped .pptx in place. Returns how many. */
export async function convertImages(files) {
    const targets = Object.keys(files).filter(name => /^ppt\/media\/[^/]+\.(webp|svg)$/i.test(name));
    if (!targets.length) return 0;
    const page = await launch();
    try {
        await page.goto('about:blank', 200);
        for (const name of targets) {
            const ext = name.split('.').pop().toLowerCase();
            const src = `data:${MIME[ext]};base64,${Buffer.from(files[name]).toString('base64')}`;
            const b64 = await page.eval(`
                const img = new Image(); img.src = ${JSON.stringify(src)}; await img.decode();
                // SVG has no fixed pixel size: draw it large enough to stay sharp
                const scale = ${ext === 'svg'} ? Math.max(1, 1200 / Math.max(img.naturalWidth || 300, img.naturalHeight || 300)) : 1;
                const c = document.createElement('canvas');
                c.width = Math.round((img.naturalWidth || 300) * scale); c.height = Math.round((img.naturalHeight || 300) * scale);
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                return c.toDataURL('image/png').split(',')[1];`);
            const png = name.replace(/\.(webp|svg)$/i, '.png');
            delete files[name];
            files[png] = new Uint8Array(Buffer.from(b64, 'base64'));
            // Every relationship pointing at the old file now points at the PNG
            const oldBase = path.posix.basename(name), newBase = path.posix.basename(png);
            for (const rel of Object.keys(files).filter(n => n.endsWith('.rels'))) {
                const xml = strFromU8(files[rel]);
                if (xml.includes(`media/${oldBase}"`)) files[rel] = strToU8(xml.split(`media/${oldBase}"`).join(`media/${newBase}"`));
            }
        }
    } finally {
        await page.close();
    }
    const typesName = '[Content_Types].xml';
    let types = strFromU8(files[typesName]);
    if (!/Extension="png"/i.test(types)) {
        types = types.replace('<Default Extension="xml"', '<Default Extension="png" ContentType="image/png"/><Default Extension="xml"');
        files[typesName] = strToU8(types);
    }
    return targets.length;
}

// Run on its own
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [, , input, output] = process.argv;
    if (!input || !output) {
        console.error('Usage: node pptx-images.mjs <in.pptx> <out.pptx>');
        process.exit(1);
    }
    const files = unzipSync(fs.readFileSync(input));
    const count = await convertImages(files);
    fs.writeFileSync(output, zipSync(files));
    console.log(`${output}: ${count} picture(s) converted to PNG`);
}
