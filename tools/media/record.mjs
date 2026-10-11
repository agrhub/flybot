// Product tour video from the screenshots: pan/zoom, captions, intro and outro.
// Recorded in headless Chrome with MediaRecorder (no ffmpeg needed).
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './cdp.mjs';

const [, , SHOTS, OUT, LANG = 'vi'] = process.argv;
const TEXT = {
    vi: {
        title: 'FlyBot', tagline: 'Bẫy dính thông minh & AI đếm côn trùng',
        outro: 'Phát hiện sâu hại sớm. Quyết định có căn cứ.', by: 'FlyBot • AgrHub',
        scenes: {
            dashboard: 'Tổng quan: ruồi vào bẫy hôm nay, ruồi/bẫy/ngày, từng bẫy so với ngưỡng',
            'catch-chart': 'Số ruồi vào bẫy mỗi ngày, theo từng bẫy',
            'dashboard-cameras': 'Ảnh mới nhất của từng bẫy, AI khoanh từng con ruồi',
            playback: 'Xem lại video theo dòng thời gian, kèm ảnh AI từng đoạn',
            'history-export': 'Lịch sử nhận diện: lọc, cảnh báo, xuất PDF và Excel kèm ảnh',
            reports: 'Báo cáo tự thiết kế, chọn khoảng thời gian, chia sẻ có thời hạn',
            insights: 'Phân tích chuyên sâu: bẫy nào đáng lo, ruồi vào giờ nào',
            cameras: 'Camera EZVIZ chụp tấm bẫy dính theo lịch',
            detection: 'AI đếm và đánh dấu từng con ruồi trên ảnh',
            history: 'Kỹ thuật viên xác nhận hoặc sửa số đếm',
            analytics: 'Ruồi mới mỗi ngày theo loài, đánh dấu ngày thay bẫy và xử lý',
            diagnosis: 'Dự báo đợt ruồi tiếp theo theo độ-ngày và gợi ý xử lý',
            notifications: 'Cảnh báo vượt ngưỡng, tăng đột biến, mất kết nối',
            map: 'Vườn và lô trên bản đồ, màu theo mức nguy cơ',
            logbook: 'Nhật ký xử lý: so sánh trước và sau, xuất sổ VietGAP',
            organizations: 'Tổ chức nhiều thành viên với phân quyền',
            'report-schedule': 'Gửi báo cáo kèm PDF qua email và Telegram theo lịch',
            assistant: 'Trợ lý FlyBot trả lời bằng số liệu thật, kèm ảnh và biểu đồ',
            'assistant-confirm': 'Trợ lý chuẩn bị, bạn bấm Xác nhận mới được ghi',
            'app-tour': 'Hướng dẫn nhanh ngay khi mở ứng dụng lần đầu',
            mobile: 'Dùng trên điện thoại như một ứng dụng'
        }
    },
    en: {
        title: 'FlyBot', tagline: 'Smart sticky traps & AI insect counting',
        outro: 'Spot pests early. Decide with evidence.', by: 'FlyBot • AgrHub',
        scenes: {
            dashboard: 'Overview: flies caught today, flies per trap per day, every trap vs its threshold',
            'catch-chart': 'Flies caught per day, by trap',
            'dashboard-cameras': 'The latest photo of each trap, every fly marked by the AI',
            playback: 'Recordings on a timeline, with the AI photo of each clip',
            'history-export': 'Detection history: filters, alarms, PDF and Excel with photos',
            reports: 'Custom reports with time ranges and sharing that expires',
            insights: 'Insights: the most worrying traps and the busiest hours',
            cameras: 'EZVIZ cameras photograph the sticky cards on a schedule',
            detection: 'AI counts and marks every fly in the photo',
            history: 'Technicians confirm or correct the counts',
            analytics: 'New flies per day by species, with card changes and treatments marked',
            diagnosis: 'Degree-day forecast of the next fly wave, with suggested actions',
            notifications: 'Alerts for thresholds, sudden rises and offline cameras',
            map: 'Farms and plots on the map, colored by risk',
            logbook: 'Treatment log: before and after, VietGAP export',
            organizations: 'Organizations with members and roles',
            'report-schedule': 'Reports with their PDF by email and Telegram on a schedule',
            assistant: 'The FlyBot assistant answers from your figures, with photos and charts',
            'assistant-confirm': 'The assistant prepares, your Confirm records it',
            'app-tour': 'A quick tour the first time you open the app',
            mobile: 'Works on the phone like an app'
        }
    }
}[LANG];

const ORDER = ['app-tour', 'dashboard', 'dashboard-cameras', 'catch-chart', 'playback', 'detection', 'history-export', 'analytics', 'insights', 'reports', 'report-schedule', 'assistant', 'assistant-confirm', 'diagnosis', 'notifications', 'map', 'logbook'];
const dataUrl = (name) => `data:image/webp;base64,${fs.readFileSync(path.join(SHOTS, `${name}.webp`)).toString('base64')}`;
const scenes = ORDER.map(name => ({ kind: 'shot', img: dataUrl(name), caption: TEXT.scenes[name] }));
scenes.push({ kind: 'phones', imgs: [dataUrl('mobile-dashboard'), dataUrl('mobile-cameras'), dataUrl('mobile-more')], caption: TEXT.scenes.mobile });

const page = await launch();
try {
    await page.viewport(1280, 720);
    await page.goto('about:blank', 300);
    const result = await page.eval(`
        const W = 1280, H = 720, FPS = 30;
        const T = ${JSON.stringify(TEXT)};
        const scenes = ${JSON.stringify(scenes)};
        const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
        for (const s of scenes) {
            if (s.img) s.image = await load(s.img);
            if (s.imgs) s.images = await Promise.all(s.imgs.map(load));
        }
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        document.body.appendChild(canvas);
        const ctx = canvas.getContext('2d');
        const GREEN = '#3ecf8e', DARK = '#0f1714';
        const ease = (x) => x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;

        function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
        function caption(text, alpha) {
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.font = '600 30px "Segoe UI", Arial, sans-serif';
            const w = Math.min(W - 120, ctx.measureText(text).width + 64);
            const x = (W - w) / 2, y = H - 104;
            roundRect(x, y, w, 64, 32);
            ctx.fillStyle = 'rgba(15, 23, 20, 0.86)'; ctx.fill();
            ctx.fillStyle = GREEN; ctx.fillRect(x + 26, y + 26, 12, 12);
            ctx.fillStyle = '#ffffff'; ctx.textBaseline = 'middle';
            ctx.fillText(text, x + 50, y + 33, w - 70);
            ctx.restore();
        }
        function titleCard(main, sub, small, p) {
            ctx.fillStyle = DARK; ctx.fillRect(0, 0, W, H);
            const g = ctx.createRadialGradient(W / 2, H / 2, 50, W / 2, H / 2, 700);
            g.addColorStop(0, 'rgba(62, 207, 142, 0.25)'); g.addColorStop(1, 'rgba(62, 207, 142, 0)');
            ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
            const a = Math.min(1, p * 3) * Math.min(1, (1 - p) * 4);
            ctx.globalAlpha = a;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillStyle = GREEN; ctx.font = '800 96px "Segoe UI", Arial, sans-serif';
            ctx.fillText(main, W / 2, H / 2 - 50 - (1 - ease(Math.min(1, p * 2))) * 20);
            ctx.fillStyle = '#ffffff'; ctx.font = '500 36px "Segoe UI", Arial, sans-serif';
            ctx.fillText(sub, W / 2, H / 2 + 30);
            if (small) { ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = '500 24px "Segoe UI", Arial, sans-serif'; ctx.fillText(small, W / 2, H / 2 + 90); }
            ctx.globalAlpha = 1; ctx.textAlign = 'left';
        }
        // A screenshot drifting slowly, framed like a window
        function shot(s, p, index) {
            ctx.fillStyle = '#e9efec'; ctx.fillRect(0, 0, W, H);
            const img = s.image;
            const z = 1.0 + 0.10 * ease(p);
            const fw = W - 80, fh = fw * img.height / img.width;
            const dx = (index % 2 ? -1 : 1) * 30 * ease(p);
            const dy = -Math.max(0, fh * z - (H - 40)) * 0.35 * ease(p);
            ctx.save();
            roundRect(40, 30, fw, H - 60, 18); ctx.clip();
            ctx.drawImage(img, 40 + dx - (fw * (z - 1)) / 2, 30 + dy, fw * z, fh * z);
            ctx.restore();
            ctx.strokeStyle = 'rgba(15,23,20,0.12)'; ctx.lineWidth = 2; roundRect(40, 30, fw, H - 60, 18); ctx.stroke();
        }
        function phones(s, p) {
            ctx.fillStyle = DARK; ctx.fillRect(0, 0, W, H);
            const ph = 600, pw = ph * s.images[0].width / s.images[0].height;
            s.images.forEach((img, i) => {
                const x = W / 2 - pw * 1.5 - 40 + i * (pw + 40);
                const rise = (1 - ease(Math.min(1, Math.max(0, p * 2.2 - i * 0.25)))) * 60;
                ctx.save();
                roundRect(x - 8, 50 + rise - 8, pw + 16, ph + 16, 36); ctx.fillStyle = '#1d2622'; ctx.fill();
                roundRect(x, 50 + rise, pw, ph, 28); ctx.clip();
                ctx.drawImage(img, x, 50 + rise, pw, ph);
                ctx.restore();
            });
        }

        const INTRO = 3.2, SCENE = 4.2, FADE = 0.35, OUTRO = 3.6;
        const timeline = [{ kind: 'intro', dur: INTRO }, ...scenes.map(s => ({ ...s, dur: SCENE })), { kind: 'outro', dur: OUTRO }];
        const total = timeline.reduce((a, s) => a + s.dur, 0);

        function frame(t) {
            let acc = 0, i = 0;
            while (i < timeline.length - 1 && t >= acc + timeline[i].dur) { acc += timeline[i].dur; i++; }
            const s = timeline[i], p = Math.min(1, (t - acc) / s.dur);
            if (s.kind === 'intro') titleCard(T.title, T.tagline, '', p);
            else if (s.kind === 'outro') titleCard(T.title, T.outro, T.by, p);
            else if (s.kind === 'phones') phones(s, p);
            else shot(s, p, i);
            if (s.caption) caption(s.caption, Math.min(1, p * 4) * Math.min(1, (1 - p) * 5));
            // Cross-fade through black between scenes
            const edge = Math.min(t - acc, acc + s.dur - t);
            if (edge < FADE && i > 0 && i < timeline.length) { ctx.fillStyle = 'rgba(0,0,0,' + (1 - edge / FADE) * 0.85 + ')'; ctx.fillRect(0, 0, W, H); }
        }

        frame(INTRO * 0.55);
        const poster = canvas.toDataURL('image/webp', 0.85);

        const types = ['video/mp4;codecs=avc1.42E01F', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
        const mime = types.find(m => MediaRecorder.isTypeSupported(m));
        const stream = canvas.captureStream(FPS);
        const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 800000 });
        const chunks = [];
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        const done = new Promise(res => rec.onstop = res);
        rec.start(1000);
        const start = performance.now();
        await new Promise(res => {
            const tick = () => {
                const t = (performance.now() - start) / 1000;
                frame(Math.min(t, total - 0.001));
                if (t < total) setTimeout(tick, 1000 / FPS); else res();
            };
            tick();
        });
        rec.stop();
        await done;
        const blob = new Blob(chunks, { type: mime });
        const b64 = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.readAsDataURL(blob); });
        return { mime, b64, poster: poster.split(',')[1], seconds: total };
    `);
    const ext = result.mime.includes('mp4') ? 'mp4' : 'webm';
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, `flybot-tour-${LANG}.${ext}`);
    fs.writeFileSync(file, Buffer.from(result.b64, 'base64'));
    fs.writeFileSync(path.join(OUT, `flybot-tour-${LANG}-poster.webp`), Buffer.from(result.poster, 'base64'));
    console.log(`${file} ${result.mime} ${Math.round(fs.statSync(file).size / 1024)} KB, ${result.seconds.toFixed(1)} s`);
} finally {
    await page.close();
}
