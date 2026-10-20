// Static server for the film: this folder at /, the media folder at /media/ (with byte ranges, so the orchard clip
// can be seeked). node serve.mjs [port] then open http://127.0.0.1:<port>/film.html (?subs=vi, ?t=42, ?from=60).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MEDIA = path.resolve(process.env.FLYBOT_FILM_MEDIA || path.join(here, 'media'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };

// extra: { '/work/': folder } for more folders (render-film.mjs serves its frames this way)
export function serve(port = 0, extra = {}) {
    const roots = { '/media/': MEDIA, ...extra };
    const server = http.createServer((req, res) => {
        const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        let file = null;
        for (const [prefix, dir] of Object.entries(roots)) if (url.startsWith(prefix)) file = path.join(dir, url.slice(prefix.length));
        if (!file) file = path.join(here, url === '/' ? 'film.html' : url);
        const base = Object.values(roots).find(d => file.startsWith(d)) || here;
        if (!path.resolve(file).startsWith(path.resolve(base))) { res.writeHead(403).end(); return; }
        fs.stat(file, (err, st) => {
            if (err || !st.isFile()) { res.writeHead(404).end(); return; }
            const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
            const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
            if (range) {
                const start = range[1] ? Number(range[1]) : 0, end = range[2] ? Number(range[2]) : st.size - 1;
                res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
                if (req.method === 'HEAD') return res.end();
                fs.createReadStream(file, { start, end }).pipe(res);
            } else {
                res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
                if (req.method === 'HEAD') return res.end();
                fs.createReadStream(file).pipe(res);
            }
        });
    });
    return new Promise(res => server.listen(port, '127.0.0.1', () => res({ server, port: server.address().port })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { port } = await serve(Number(process.argv[2]) || 8090);
    console.log(`http://127.0.0.1:${port}/film.html`);
}
