// The Vietnamese voice-over of the introduction film, spoken by Microsoft's online neural voices (Edge TTS) from the
// subtitle lines of script.js:
//   node voice.mjs [voice=vi-VN-NamMinhNeural] [rate=+0%]    -> ../film/media/promo-voice/<scene>-<n>.wav and manifest.json
// Only the lines of script.js are sent to the service. A recorded voice can replace any line: put <scene>-<n>.wav in
// that folder and its length in seconds in manifest.json.
// Pronunciation: SAY rewrites a few words for the speech only (the subtitles keep the written form).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SCENES } from './script.js';
import { MEDIA } from '../film/serve.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [, , voice = 'vi-VN-NamMinhNeural', rate = '+0%'] = process.argv;
const SAY = [
    [/flybot\.agrhub\.com/g, 'flai bót chấm ác háp chấm com'], [/\bFlyBot\b/g, 'Flai Bót'], [/\bAgrHub\b/g, 'Ác Háp'],
    [/\bAI\b/g, 'Ây Ai'], [/\b4G\b/g, 'bốn G'], [/\bWi-Fi\b/g, 'wai phai'], [/\bVietGAP\b/g, 'Việt GAP'], [/\bemail\b/g, 'i meo']
];
const say = (t) => SAY.reduce((s, [re, to]) => s.replace(re, to), t);
const dir = path.join(MEDIA, 'promo-voice');
fs.mkdirSync(dir, { recursive: true });
const lines = SCENES.flatMap(s => s.lines.map((l, i) => ({ id: `${s.id}-${i}`, text: say(l.vi) })));
const file = path.join(dir, 'lines.json');
fs.writeFileSync(file, JSON.stringify(lines, null, 1));
const r = spawnSync('uv', ['run', '--no-project', '-q', '--python', '3.12', '--with', 'edge-tts', '--with', 'soundfile',
    'python', '-I', path.join(here, 'tts_edge.py'), file, dir, voice, rate], { stdio: 'inherit' });
process.exit(r.status ?? 1);
