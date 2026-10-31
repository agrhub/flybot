# Speaks the introduction film's lines with Edge TTS (online): tts_edge.py <lines.json> <outdir> [voice] [rate]
# lines.json: [{"id": "...", "text": "..."}]. Writes <id>.wav and manifest.json {id: seconds}; the leading and
# trailing silence of each line is cut, so a line starts on its cue.
# Each line is spoken in one request, so its intonation runs through the whole sentence. The service sometimes returns
# no audio for a longer Vietnamese line: only then is it split, first into sentences, then at commas and colons, last
# in half, and the pieces are joined with the pause the punctuation calls for (short fades hide the joins).
import asyncio, io, json, os, re, sys
import numpy as np
import soundfile as sf
import edge_tts

lines_file, out = sys.argv[1], sys.argv[2]
voice = sys.argv[3] if len(sys.argv) > 3 else 'vi-VN-NamMinhNeural'
rate = sys.argv[4] if len(sys.argv) > 4 else '+0%'
PAUSE = {',': 0.18, ':': 0.28, ';': 0.28, '.': 0.38, '?': 0.38, '!': 0.38, '': 0.08}
SPLITS = [r'[^.?!]+[.?!]?', r'[^,:;.?!]+[,:;.?!]?']


def trim(samples, sr):
    loud = np.flatnonzero(np.abs(samples) > 0.005)
    return samples[max(0, loud[0] - int(0.05 * sr)):loud[-1] + int(0.15 * sr)] if len(loud) else samples


def fade(samples, sr):
    n = min(len(samples) // 2, int(0.01 * sr))
    ramp = np.linspace(0, 1, n, dtype='float32')
    samples = samples.copy()
    samples[:n] *= ramp
    samples[len(samples) - n:] *= ramp[::-1]
    return samples


async def attempt(text):
    for i in range(4):
        mp3 = bytearray()
        try:
            async for chunk in edge_tts.Communicate(text, voice, rate=rate).stream():
                if chunk['type'] == 'audio':
                    mp3 += chunk['data']
            samples, sr = sf.read(io.BytesIO(bytes(mp3)), dtype='float32')
            return trim(samples, sr), sr
        except edge_tts.exceptions.NoAudioReceived:
            await asyncio.sleep(1 + i)
    return None


async def speak(text, level=0):
    """Samples and rate of the text, and how many pieces it took."""
    got = await attempt(text)
    if got:
        return got[0], got[1], 1
    if level < len(SPLITS):
        pieces = [p.strip() for p in re.findall(SPLITS[level], text) if p.strip()]
    else:
        words = text.split()
        if len(words) < 2:
            raise RuntimeError(f'no audio for a single word ({len(text)} characters)')
        pieces = [' '.join(words[:len(words) // 2]), ' '.join(words[len(words) // 2:])]
    if len(pieces) < 2:
        return await speak(text, level + 1)
    parts, sr, count = [], 24000, 0
    for piece in pieces:
        samples, sr, n = await speak(piece, level + 1)
        count += n
        parts.append(fade(samples, sr))
        parts.append(np.zeros(int(PAUSE.get(piece[-1], PAUSE['']) * sr), dtype='float32'))
    return np.concatenate(parts[:-1]), sr, count


async def main():
    manifest = {}
    for line in json.load(open(lines_file, encoding='utf-8')):
        samples, sr, pieces = await speak(line['text'])
        sf.write(os.path.join(out, line['id'] + '.wav'), samples, sr)
        manifest[line['id']] = round(len(samples) / sr, 3)
        print(line['id'], manifest[line['id']], 's' if pieces == 1 else f's, in {pieces} pieces', flush=True)
    json.dump(manifest, open(os.path.join(out, 'manifest.json'), 'w'), indent=1)

asyncio.run(main())
