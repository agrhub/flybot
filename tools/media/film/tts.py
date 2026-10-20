# Speaks the film's lines with Kokoro (open weights, Apache-2.0), offline: tts.py <lines.json> <outdir> [voice] [speed]
# lines.json: [{"id": "...", "text": "..."}]. Writes <id>.wav (24 kHz mono) and manifest.json {id: seconds}.
# Model files in media/tts (see README): kokoro-v1.0.onnx, voices-v1.0.bin.
import json, os, sys
import soundfile as sf
from kokoro_onnx import Kokoro

lines_file, out = sys.argv[1], sys.argv[2]
voice = sys.argv[3] if len(sys.argv) > 3 else 'af_heart'
speed = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
model = os.path.join(os.path.dirname(os.path.abspath(lines_file)), '..', 'tts')
k = Kokoro(os.path.join(model, 'kokoro-v1.0.onnx'), os.path.join(model, 'voices-v1.0.bin'))
manifest = {}
for line in json.load(open(lines_file, encoding='utf-8')):
    samples, rate = k.create(line['text'], voice=voice, speed=speed, lang='en-us')
    sf.write(os.path.join(out, line['id'] + '.wav'), samples, rate)
    manifest[line['id']] = round(len(samples) / rate, 3)
    print(line['id'], manifest[line['id']], flush=True)
json.dump(manifest, open(os.path.join(out, 'manifest.json'), 'w'), indent=1)
