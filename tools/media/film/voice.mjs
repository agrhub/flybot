// The English voice-over, spoken offline by Kokoro (tts.py) from the lines in script.js:
//   node voice.mjs [voice=af_heart] [speed=1]      -> media/voice/<scene>-<n>.wav and manifest.json
// A recorded voice can replace any line: put <scene>-<n>.wav in media/voice and its length in seconds in manifest.json.
// Pronunciation: SAY rewrites a few words for the speech only (the subtitles keep the written form).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SCENES } from './script.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MEDIA = path.resolve(process.env.FLYBOT_FILM_MEDIA || path.join(here, 'media'));
const [, , voice = 'af_heart', speed = '1'] = process.argv;
const SAY = [
    [/\bFlyBot\b/g, 'Fly Bot'], [/\bOpenCV\b/g, 'Open C V'], [/\bAWS\b/g, 'A W S'], [/\bESP32-S3\b/g, 'E S P thirty-two S3'],
    [/\bESP32\b/g, 'E S P thirty-two'], [/\b4G\b/g, 'four G'], [/\bGPS\b/g, 'G P S'], [/\b18650\b/g, 'eighteen six fifty'],
    [/\bYOLO26n\b/g, 'YOLO twenty-six nano'], [/\bDNN\b/g, 'D N N'], [/\bmAP\b/g, 'm A P'], [/\bSAM\b/g, 'SAM'],
    [/\bIoT\b/g, 'I o T'], [/\b0\.953\b/g, 'zero point nine five three'], [/\b0\.07\b/g, 'zero point zero seven'], [/\b0\.82\b/g, 'zero point eight two'],
    [/\b114\b/g, 'a hundred and fourteen'], [/\b47\b/g, 'forty-seven'], [/\b38 of 38\b/g, 'thirty-eight of thirty-eight'], [/\b17 dollars\b/g, 'seventeen dollars']
];
const say = (t) => SAY.reduce((s, [re, to]) => s.replace(re, to), t);
const dir = path.join(MEDIA, 'voice');
fs.mkdirSync(dir, { recursive: true });
const lines = SCENES.flatMap(s => s.lines.map((l, i) => ({ id: `${s.id}-${i}`, text: say(l.en) })));
const file = path.join(dir, 'lines.json');
fs.writeFileSync(file, JSON.stringify(lines, null, 1));
const r = spawnSync('uv', ['run', '--no-project', '-q', '--python', '3.12', '--with', 'kokoro-onnx==0.6.1', '--with', 'soundfile',
    'python', '-I', path.join(here, 'tts.py'), file, dir, voice, speed], { stdio: 'inherit' });
process.exit(r.status ?? 1);
