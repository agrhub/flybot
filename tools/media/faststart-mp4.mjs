// Move an MP4's index (moov) in front of the media data, like ffmpeg's "-movflags faststart":
// browsers can start playing after the first few KB instead of fetching the end of the file
// first. Windows' encoder (remux-mp4.ps1) writes the index at the end.
// Usage: node faststart-mp4.mjs <in.mp4> <out.mp4>
import fs from 'node:fs';

const [, , input, output] = process.argv;
if (!input || !output) {
    console.error('Usage: node faststart-mp4.mjs <in.mp4> <out.mp4>');
    process.exit(1);
}
const data = fs.readFileSync(input);

// Top-level boxes: [type, start, size]
function boxes(buf, start, end) {
    const list = [];
    for (let pos = start; pos + 8 <= end;) {
        let size = buf.readUInt32BE(pos);
        const type = buf.toString('latin1', pos + 4, pos + 8);
        let header = 8;
        if (size === 1) { size = Number(buf.readBigUInt64BE(pos + 8)); header = 16; }
        else if (size === 0) size = end - pos;
        if (size < header || pos + size > end) throw new Error(`Broken box ${type} at ${pos}`);
        list.push({ type, start: pos, size, header });
        pos += size;
    }
    return list;
}

const top = boxes(data, 0, data.length);
const moov = top.find(b => b.type === 'moov');
const mdat = top.find(b => b.type === 'mdat');
if (!moov || !mdat) throw new Error('No moov or mdat box');
if (moov.start < mdat.start) {
    fs.copyFileSync(input, output);
    console.log(`${output}: index already at the start`);
    process.exit(0);
}

// The index moves in front of everything after ftyp, so every chunk offset grows by its size
const index = Buffer.from(data.subarray(moov.start, moov.start + moov.size));
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex', 'udta']);
let patched = 0;
(function shift(start, end) {
    for (const box of boxes(index, start, end)) {
        const body = box.start + box.header;
        if (CONTAINERS.has(box.type)) shift(body, box.start + box.size);
        else if (box.type === 'stco' || box.type === 'co64') {
            const count = index.readUInt32BE(body + 4);
            for (let i = 0; i < count; i++) {
                if (box.type === 'stco') {
                    const at = body + 8 + i * 4;
                    const value = index.readUInt32BE(at) + moov.size;
                    if (value > 0xffffffff) throw new Error('File too large for 32-bit chunk offsets');
                    index.writeUInt32BE(value, at);
                } else {
                    const at = body + 8 + i * 8;
                    index.writeBigUInt64BE(index.readBigUInt64BE(at) + BigInt(moov.size), at);
                }
            }
            patched += count;
        }
    }
})(0, index.length);

const ftyp = top.find(b => b.type === 'ftyp');
const head = ftyp ? data.subarray(0, ftyp.start + ftyp.size) : Buffer.alloc(0);
const rest = top.filter(b => b !== ftyp && b !== moov).map(b => data.subarray(b.start, b.start + b.size));
if (ftyp && ftyp.start !== 0) throw new Error('ftyp is not the first box');
fs.writeFileSync(output, Buffer.concat([head, index, ...rest]));
console.log(`${output}: index moved to the start (${patched} chunk offsets updated)`);
