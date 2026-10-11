// Embed a video in an exported deck: PDF and PPTX exports show a video as its still frame, so
// this turns the largest picture on one slide into a playable video (PowerPoint 2010 and later).
// Usage: node embed-video-pptx.mjs <in.pptx> <slide number> <video.mp4> <out.pptx>
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { unzipSync, zipSync, strFromU8, strToU8 } = require(require.resolve('fflate', { paths: [new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')] }));

const [, , input, slideArg, videoPath, output] = process.argv;
if (!input || !slideArg || !videoPath || !output) {
    console.error('Usage: node embed-video-pptx.mjs <in.pptx> <slide number> <video.mp4> <out.pptx>');
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
    const ext = m[0].match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
    return { text: m[0], area: ext ? Number(ext[1]) * Number(ext[2]) : 0 };
});
if (!pics.length) throw new Error(`No picture on slide ${slide}`);
const pic = pics.sort((a, b) => b.area - a.area)[0].text;
if (pic.includes('<a:videoFile')) throw new Error(`Slide ${slide} already has a video`);

// The video file, once in the package
let n = 1;
while (files[`ppt/media/media${n}.mp4`]) n++;
const mediaName = `media${n}.mp4`;
files[`ppt/media/${mediaName}`] = new Uint8Array(fs.readFileSync(videoPath));

// Two relationships to it: the video link (PowerPoint 2007) and the embedded media (2010+)
const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map(m => Number(m[1]));
const videoId = `rId${Math.max(0, ...ids) + 1}`;
const mediaId = `rId${Math.max(0, ...ids) + 2}`;
rels = rels.replace('</Relationships>',
    `<Relationship Id="${videoId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="../media/${mediaName}"/>`
    + `<Relationship Id="${mediaId}" Type="http://schemas.microsoft.com/office/2007/relationships/media" Target="../media/${mediaName}"/>`
    + '</Relationships>');

// The picture becomes a video: a play action on click and the media in its non-visual properties
const video = pic
    .replace(/(<p:cNvPr [^>]*?)(\/>|>)/, (m, open, close) => (close === '/>'
        ? `${open}><a:hlinkClick r:id="" action="ppaction://media"/></p:cNvPr>`
        : `${open}><a:hlinkClick r:id="" action="ppaction://media"/>`))
    .replace(/<p:nvPr\s*\/>|<p:nvPr>\s*<\/p:nvPr>/, `<p:nvPr><a:videoFile r:link="${videoId}"/><p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="${mediaId}"/></p:ext></p:extLst></p:nvPr>`);
if (!video.includes('<a:videoFile')) throw new Error('Could not place the video in the picture');
xml = xml.replace(pic, video);

files[slidePath] = strToU8(xml);
files[relsPath] = strToU8(rels);
// mp4 is usually declared already; add it if not
let types = strFromU8(files['[Content_Types].xml']);
if (!/Extension="mp4"/.test(types)) {
    types = types.replace('<Default Extension="xml"', '<Default Extension="mp4" ContentType="video/mp4"/><Default Extension="xml"');
    files['[Content_Types].xml'] = strToU8(types);
}

// Video is already compressed: store it as is
const zipped = zipSync(Object.fromEntries(Object.entries(files).map(([name, data]) => [name, name.endsWith('.mp4') ? [data, { level: 0 }] : data])));
fs.writeFileSync(output, zipped);
console.log(`${output}: video on slide ${slide} (${Math.round(zipped.length / 1024)} KB)`);
