// Make the video's still frame in an exported deck open the online video: the largest picture on
// the slide links to the URL and gets a play button. Nothing is embedded, so a new video on the
// website shows up without touching the deck. (PowerPoint does not play a linked .mp4 URL itself,
// only YouTube/Vimeo/Stream, so the link opens in the browser.)
// Usage: node link-video-pptx.mjs <in.pptx> <slide number> <video URL> <out.pptx>
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { unzipSync, zipSync, strFromU8, strToU8 } = require(require.resolve('fflate', { paths: [new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')] }));

const [, , input, slideArg, url, output] = process.argv;
if (!input || !slideArg || !/^https?:\/\//.test(url || '') || !output) {
    console.error('Usage: node link-video-pptx.mjs <in.pptx> <slide number> <https://… video URL> <out.pptx>');
    process.exit(1);
}
const slide = Number(slideArg);
const files = unzipSync(fs.readFileSync(input));
const slidePath = `ppt/slides/slide${slide}.xml`;
const relsPath = `ppt/slides/_rels/slide${slide}.xml.rels`;
if (!files[slidePath]) throw new Error(`No slide ${slide} in ${input}`);

let xml = strFromU8(files[slidePath]);
let rels = strFromU8(files[relsPath]);

// The largest picture on the slide is the video's still frame
const pics = [...xml.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)].map(m => {
    const off = m[0].match(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/);
    const ext = m[0].match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
    return { text: m[0], x: +off?.[1] || 0, y: +off?.[2] || 0, cx: +ext?.[1] || 0, cy: +ext?.[2] || 0 };
});
if (!pics.length) throw new Error(`No picture on slide ${slide}`);
const pic = pics.sort((a, b) => b.cx * b.cy - a.cx * a.cy)[0];
if (pic.text.includes('<a:hlinkClick')) throw new Error(`The picture on slide ${slide} already has a link`);

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map(m => Number(m[1]));
const linkId = `rId${Math.max(0, ...ids) + 1}`;
rels = rels.replace('</Relationships>',
    `<Relationship Id="${linkId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(url)}" TargetMode="External"/></Relationships>`);
const hlink = `<a:hlinkClick r:id="${linkId}"/>`;

// Clicking the picture opens the video
const linked = pic.text.replace(/(<p:cNvPr [^>]*?)(\/>|>)/, (m, open, close) => (close === '/>' ? `${open}>${hlink}</p:cNvPr>` : `${open}>${hlink}`));

// A round play button in the middle (also a link)
const shapeIds = [...xml.matchAll(/<p:cNvPr id="(\d+)"/g)].map(m => Number(m[1]));
let nextId = Math.max(0, ...shapeIds) + 1;
const d = Math.round(Math.min(pic.cx, pic.cy) * 0.18);
const cx = pic.x + Math.round((pic.cx - d) / 2);
const cy = pic.y + Math.round((pic.cy - d) / 2);
const t = Math.round(d * 0.42);
const shape = (name, geom, x, y, w, h, fill, alpha, rot = 0) => `<p:sp><p:nvSpPr><p:cNvPr id="${nextId++}" name="${name}">${hlink}</p:cNvPr><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr><a:xfrm${rot ? ` rot="${rot}"` : ''}><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>`
    + `<a:solidFill><a:srgbClr val="${fill}"><a:alpha val="${alpha}"/></a:srgbClr></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`;
const button = shape('Play video', 'ellipse', cx, cy, d, d, 'F2C230', 92000)
    // A triangle pointing right: the preset points up, so turn it 90°; nudged right to look centred
    + shape('Play icon', 'triangle', cx + Math.round((d - t) / 2 + t * 0.08), cy + Math.round((d - t) / 2), t, t, '13261D', 100000, 5400000);

xml = xml.replace(pic.text, linked + button);
files[slidePath] = strToU8(xml);
files[relsPath] = strToU8(rels);
fs.writeFileSync(output, zipSync(files));
console.log(`${output}: picture on slide ${slide} opens ${url}`);
