// Get a deck exported from the Slides artifact ready for PowerPoint, in one step:
// 1. text in Arial: the deck's web font (Be Vietnam Pro) is not embedded, and where it is not
//    installed PowerPoint mis-wraps Vietnamese lines (a word repeated at line ends)
// 2. Vietnamese text tagged vi-VN (the export tags everything en-US)
// 3. text boxes the export laid over each other (two-column grids) moved apart
// 4. WebP and SVG pictures turned into PNG: Google Slides and Drive's preview show neither
// 5. the tour video linked, not embedded: the file stays small, Google Slides (which cannot play
//    embedded video) shows it the same way, and a new video on the website needs no new deck
// Usage: node prepare-deck-pptx.mjs <exported.pptx> <vi|en> <video URL> <out.pptx> [slide with the video, default 4]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { convertImages } from './pptx-images.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { unzipSync, zipSync, strFromU8, strToU8 } = require(require.resolve('fflate', { paths: [path.join(here, '../..')] }));

const [, , input, lang, url, output, slideArg = '4'] = process.argv;
if (!input || !['vi', 'en'].includes(lang) || !/^https?:\/\//.test(url || '') || !output) {
    console.error('Usage: node prepare-deck-pptx.mjs <exported.pptx> <vi|en> <video URL> <out.pptx> [slide]');
    process.exit(1);
}

const EMU = 6350;         // per pixel of the 1920x1080 slide
const COLUMN_GAP = 48;    // px between grid columns, as in the slides
const ROW_GAP = 20;       // px kept between a block and the one below it
const WEB_FONT = 'Be Vietnam Pro';
const FONT = 'Arial';

const files = unzipSync(fs.readFileSync(input));
const report = { fonts: 0, columns: 0, rows: 0, images: 0 };

for (const name of Object.keys(files)) {
    if (!/^ppt\/(slides|slideLayouts|slideMasters|theme)\/[^/]+\.xml$/.test(name)) continue;
    let xml = strFromU8(files[name]);
    const before = xml;
    report.fonts += (xml.match(new RegExp(`typeface="${WEB_FONT}"`, 'g')) || []).length;
    xml = xml.split(`typeface="${WEB_FONT}"`).join(`typeface="${FONT}"`);
    if (lang === 'vi') xml = xml.replace(/lang="en-US"/g, 'lang="vi-VN"');
    if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) xml = separateBoxes(xml);
    if (xml !== before) files[name] = strToU8(xml);
}

/** Text boxes on one slide that overlap: narrow a left column, push a row down. */
function separateBoxes(xml) {
    const shapes = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map(m => m[0]);
    const boxes = shapes.map(text => {
        const off = text.match(/<a:off x="(\d+)" y="(\d+)"\/>/);
        const ext = text.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
        if (!off || !ext || !/<a:t>/.test(text)) return null;
        return { text, x: +off[1] / EMU, y: +off[2] / EMU, w: +ext[1] / EMU, h: +ext[2] / EMU };
    }).filter(Boolean);
    const overlapsVertically = (a, b) => a.y < b.y + b.h && b.y < a.y + a.h;

    // Columns: a box running into the box to its right stops one gap short of it (boxes that only
    // sit close together are left alone)
    for (const a of boxes) {
        for (const b of boxes) {
            if (a !== b && a.x < b.x && a.x + a.w > b.x + 1 && overlapsVertically(a, b)) {
                a.w = Math.max(40, b.x - a.x - COLUMN_GAP);
                report.columns++;
            }
        }
    }
    // Rows: in a column, a box reaching into the next one pushes it (and everything level with
    // or below it in those columns) down
    const columns = [...new Set(boxes.map(b => Math.round(b.x)))];
    const gridColumns = columns.filter(x => boxes.filter(b => Math.round(b.x) === x).length > 1);
    for (const x of gridColumns) {
        const column = boxes.filter(b => Math.round(b.x) === x).sort((a, b) => a.y - b.y);
        for (let i = 1; i < column.length; i++) {
            const prev = column[i - 1], cur = column[i];
            const overlap = prev.y + prev.h - cur.y;
            // Title and text of one block sit a few px apart on purpose: only fix real overlaps
            if (overlap > 0) {
                const shift = overlap + ROW_GAP;
                const top = cur.y;
                for (const b of boxes) if (gridColumns.includes(Math.round(b.x)) && b.y >= top - 1) b.y += shift;
                report.rows++;
            }
        }
    }
    for (const b of boxes) {
        const updated = b.text
            .replace(/<a:off x="(\d+)" y="\d+"\/>/, (m, x) => `<a:off x="${x}" y="${Math.round(b.y * EMU)}"/>`)
            .replace(/<a:ext cx="\d+" cy="(\d+)"\/>/, (m, cy) => `<a:ext cx="${Math.round(b.w * EMU)}" cy="${cy}"/>`);
        if (updated !== b.text) xml = xml.replace(b.text, updated);
    }
    return xml;
}

report.images = await convertImages(files);

const fixed = `${path.resolve(output)}.tmp.pptx`;
fs.writeFileSync(fixed, zipSync(files));
try {
    execFileSync(process.execPath, [path.join(here, 'link-video-pptx.mjs'), fixed, slideArg, url, output], { stdio: 'inherit' });
} finally {
    fs.rmSync(fixed, { force: true });
}
console.log(`Fonts: ${report.fonts} set to ${FONT}; boxes: ${report.columns} narrowed, ${report.rows} rows moved down; pictures: ${report.images} converted to PNG`);
