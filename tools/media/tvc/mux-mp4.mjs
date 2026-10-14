// Writes H.264 + AAC packets (from encode.html) into a plain MP4 with its index (moov) in front,
// so browsers start playing at once and Windows players and PowerPoint accept it.
// writeMp4(file, { video, audio }): each track has samples [{ size, ts, dur, key }] in decode order,
// data (Buffer of the packets back to back) and description (avcC / AudioSpecificConfig, hex).
import fs from 'node:fs';

const u8 = (n) => Buffer.from([n & 255]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const str = (s) => Buffer.from(s, 'latin1');
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(body.length + 8), str(type), body]); };
const full = (type, version, flags, ...parts) => box(type, u8(version), u8(flags >> 16), u16(flags & 0xffff), ...parts);
const zeros = (n) => Buffer.alloc(n);
// Identity matrix
const MATRIX = Buffer.concat([0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32));

// Sample durations as runs: [[count, delta], ...]
function runs(deltas) {
    const out = [];
    for (const d of deltas) {
        if (out.length && out[out.length - 1][1] === d) out[out.length - 1][0]++;
        else out.push([1, d]);
    }
    return out;
}

function sampleTable(track, offsets, sampleEntry) {
    const n = track.samples.length;
    const deltas = track.deltas;
    const stts = runs(deltas);
    const parts = [
        full('stsd', 0, 0, u32(1), sampleEntry),
        full('stts', 0, 0, u32(stts.length), ...stts.flatMap(([c, d]) => [u32(c), u32(d)]))
    ];
    if (track.kind === 'video') {
        const keys = track.samples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
        parts.push(full('stss', 0, 0, u32(keys.length), ...keys.map(u32)));
    }
    parts.push(
        // One sample a chunk
        full('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)),
        full('stsz', 0, 0, u32(0), u32(n), ...track.samples.map((s) => u32(s.size))),
        full('stco', 0, 0, u32(n), ...offsets.map(u32))
    );
    return box('stbl', ...parts);
}

function videoEntry(v) {
    return box('avc1', zeros(6), u16(1), zeros(16), u16(v.width), u16(v.height),
        u32(0x480000), u32(0x480000), u32(0), u16(1), zeros(32), u16(0x18), u16(0xffff),
        box('avcC', Buffer.from(v.description, 'hex')));
}

function audioEntry(a) {
    // AAC LC, 48 kHz, stereo unless the encoder gave its own config
    const asc = a.description ? Buffer.from(a.description, 'hex') : Buffer.from([0x11, 0x90]);
    const desc = (tag, body) => Buffer.concat([u8(tag), u8(body.length), body]);
    const decoderConfig = desc(4, Buffer.concat([u8(0x40), u8(0x15), zeros(3), u32(192000), u32(192000), desc(5, asc)]));
    const es = desc(3, Buffer.concat([u16(1), u8(0), decoderConfig, desc(6, u8(2))]));
    return box('mp4a', zeros(6), u16(1), zeros(8), u16(a.channels), u16(16), u16(0), u16(0), u32(a.rate * 65536),
        full('esds', 0, 0, es));
}

function trak(track, id, offsets, movieScale) {
    const isVideo = track.kind === 'video';
    const total = track.deltas.reduce((s, d) => s + d, 0);
    const movieDuration = Math.round(total * movieScale / track.timescale);
    const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(movieDuration), zeros(8),
        u16(0), u16(isVideo ? 0 : 1), u16(isVideo ? 0 : 0x100), u16(0), MATRIX,
        u32(isVideo ? track.width * 65536 : 0), u32(isVideo ? track.height * 65536 : 0));
    const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(track.timescale), u32(total), u16(0x55c4), u16(0));
    const hdlr = full('hdlr', 0, 0, u32(0), str(isVideo ? 'vide' : 'soun'), zeros(12), str(isVideo ? 'FlyBot video\0' : 'FlyBot sound\0'));
    const head = isVideo ? full('vmhd', 0, 1, zeros(8)) : full('smhd', 0, 0, zeros(4));
    const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
    const stbl = sampleTable(track, offsets, isVideo ? videoEntry(track) : audioEntry(track));
    return { box: box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', head, dinf, stbl))), movieDuration };
}

export function writeMp4(file, { video, audio }) {
    const MOVIE_SCALE = 1000;
    const tracks = [
        // Video at 1000 ticks a frame, audio in samples
        { ...video, kind: 'video', timescale: video.fps * 1000, deltas: video.samples.map(() => 1000) },
        { ...audio, kind: 'audio', timescale: audio.rate, deltas: audio.samples.map((s) => Math.round(s.dur * audio.rate / 1e6) || 1024) }
    ];
    // Decode order must be presentation order: there is no composition offset table
    for (let i = 1; i < video.samples.length; i++) {
        if (video.samples[i].ts <= video.samples[i - 1].ts) throw new Error('The video has reordered frames (B-frames), which this writer does not support');
    }
    // Packets interleaved by time, each track's read position kept
    const order = [];
    tracks.forEach((t, k) => {
        let pos = 0;
        t.samples.forEach((s) => { order.push({ k, ts: s.ts, pos, size: s.size }); pos += s.size; });
    });
    order.sort((a, b) => a.ts - b.ts || a.k - b.k);

    const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));
    const build = (base) => {
        const offsets = tracks.map(() => []);
        let at = base;
        for (const o of order) { offsets[o.k].push(at); at += o.size; }
        const traks = tracks.map((t, k) => trak(t, k + 1, offsets[k], MOVIE_SCALE));
        const duration = Math.max(...traks.map((t) => t.movieDuration));
        const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(MOVIE_SCALE), u32(duration), u32(0x10000), u16(0x100), zeros(10), MATRIX, zeros(24), u32(tracks.length + 1));
        return box('moov', mvhd, ...traks.map((t) => t.box));
    };
    // The index's size does not depend on the offsets, so build it twice
    const mdatSize = tracks.reduce((s, t) => s + t.data.length, 0);
    const moov = build(ftyp.length + build(0).length + 8);
    const fd = fs.openSync(file, 'w');
    try {
        fs.writeSync(fd, ftyp);
        fs.writeSync(fd, moov);
        fs.writeSync(fd, Buffer.concat([u32(mdatSize + 8), str('mdat')]));
        for (const o of order) fs.writeSync(fd, tracks[o.k].data, o.pos, o.size);
    } finally {
        fs.closeSync(fd);
    }
}
