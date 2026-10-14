// The TVC's music, synthesized in the browser (Web Audio, no samples): 100 BPM, 2.4 s a bar,
// built on the same bars as the scenes of a TVC page. makeMusic(seconds, arrangement) ->
// Promise<AudioBuffer>; the arrangement (ARRANGEMENTS below) says what plays on which bar.
(function () {
    const BPM = 100;
    const BEAT = 60 / BPM;
    const BAR = BEAT * 4;
    const freq = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
    // Chords as MIDI notes
    const CH = {
        Am: [57, 60, 64], F: [53, 57, 60], Dm: [50, 53, 57], E: [52, 56, 59],
        C: [48, 52, 55], G: [55, 59, 62], Em: [52, 55, 59]
    };
    // Bars (from 0) of each part. progression: one chord a bar, scene by scene; quietTo: the soft
    // opening ends; bassFrom; halfKick: [from, to) with a kick every two beats; groove: [from, to)
    // with the full beat and arpeggio; clapFrom; brand: bars with bells; rise: the bar the noise
    // rise leads into; hits: bars with an impact; endFrom: the bright closing pad.
    const ARRANGEMENTS = {
        // tvc.html, 60 s
        landscape: {
            progression: [
                'Am', 'F', 'Am',            // 1. hook
                'Dm', 'F', 'E',             // 2. problem
                'C', 'G',                   // 3. brand
                'C', 'G', 'Am', 'F',        // 4. how it works
                'C', 'G', 'Am', 'F',        // 5. app demo
                'C', 'G', 'F',              // 6. features
                'Am', 'F', 'G',             // 7. cooperative
                'C', 'F', 'C'               // 8. call to action
            ],
            quietTo: 3, bassFrom: 3, halfKick: [3, 6], groove: [8, 24], clapFrom: 12, brand: [6, 7], rise: 6, hits: [6, 22], endFrom: 22
        },
        // tvc-vertical.html, 30 s
        vertical: {
            progression: [
                'Am', 'E',                  // 1. hook
                'C',                        // 2. brand
                'Am', 'F', 'G',             // 3. how it works
                'C', 'G', 'Am',             // 4. the app
                'F', 'G',                   // 5. features
                'C', 'C'                    // 6. call to action
            ],
            quietTo: 2, bassFrom: 1, halfKick: [1, 3], groove: [3, 11], clapFrom: 6, brand: [2], rise: 2, hits: [2, 11], endFrom: 11
        }
    };

    async function makeMusic(seconds = 60, arrangement = ARRANGEMENTS.landscape, rate = 48000) {
        const A = typeof arrangement === 'string' ? ARRANGEMENTS[arrangement] : arrangement;
        const ctx = new OfflineAudioContext(2, Math.ceil(seconds * rate), rate);
        const master = ctx.createGain();
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.2;
        master.connect(comp).connect(ctx.destination);
        master.gain.setValueAtTime(0, 0);
        master.gain.linearRampToValueAtTime(0.9, 1.2);
        master.gain.setValueAtTime(0.9, seconds - 2.2);
        master.gain.linearRampToValueAtTime(0, seconds - 0.1);

        // A little room: two short delays panned apart
        const verb = ctx.createGain(); verb.gain.value = 0.22;
        [[0.13, -0.6], [0.21, 0.6]].forEach(([time, pan]) => {
            const d = ctx.createDelay(1); d.delayTime.value = time;
            const fb = ctx.createGain(); fb.gain.value = 0.35;
            const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2500;
            const p = ctx.createStereoPanner(); p.pan.value = pan;
            verb.connect(d); d.connect(lp).connect(fb).connect(d); lp.connect(p).connect(master);
        });

        const noise = ctx.createBuffer(1, rate * 2, rate);
        const nd = noise.getChannelData(0);
        let s = 12345;
        for (let i = 0; i < nd.length; i++) { s = (s * 16807) % 2147483647; nd[i] = (s / 2147483647) * 2 - 1; }

        function voice({ f, t, dur, type = 'sawtooth', gain = 0.05, cutoff = 1500, attack = 0.02, release = 0.3, detune = 0, pan = 0, wet = true }) {
            const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = detune;
            const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = cutoff;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(gain, t + attack);
            g.gain.setValueAtTime(gain, Math.max(t + attack, t + dur - release));
            g.gain.linearRampToValueAtTime(0, t + dur);
            const p = ctx.createStereoPanner(); p.pan.value = pan;
            o.connect(lp).connect(g).connect(p).connect(master);
            if (wet) p.connect(verb);
            o.start(t); o.stop(t + dur + 0.05);
        }
        function noiseHit({ t, dur, type, f, q = 1, gain, pan = 0 }) {
            const src = ctx.createBufferSource(); src.buffer = noise;
            const flt = ctx.createBiquadFilter(); flt.type = type; flt.frequency.value = f; flt.Q.value = q;
            const g = ctx.createGain();
            g.gain.setValueAtTime(gain, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + dur);
            const p = ctx.createStereoPanner(); p.pan.value = pan;
            src.connect(flt).connect(g).connect(p).connect(master);
            src.start(t, (t * 7.3) % 1.5); src.stop(t + dur + 0.02);
        }
        const kick = (t, gain = 0.9) => {
            const o = ctx.createOscillator(); o.type = 'sine';
            o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
            const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
            o.connect(g).connect(master); o.start(t); o.stop(t + 0.45);
        };
        const hat = (t, gain = 0.12) => noiseHit({ t, dur: 0.05, type: 'highpass', f: 7500, gain, pan: 0.25 });
        const clap = (t) => { [0, 0.012, 0.024].forEach((d) => noiseHit({ t: t + d, dur: 0.14, type: 'bandpass', f: 1600, q: 0.9, gain: 0.35, pan: -0.1 })); };

        A.progression.forEach((name, bar) => {
            const t = bar * BAR;
            if (t >= seconds) return;
            const chord = CH[name];
            const brand = A.brand.includes(bar);
            const groove = bar >= A.groove[0] && bar < A.groove[1];
            const end = bar >= A.endFrom;
            // Pad: every bar, softer in the hook
            chord.forEach((m, i) => {
                [-8, 8].forEach((det, k) => voice({ f: freq(m), t, dur: BAR + 0.4, gain: bar < A.quietTo ? 0.03 : 0.04, cutoff: brand || end ? 2400 : 1100, attack: 0.5, release: 0.8, detune: det, pan: k ? 0.4 : -0.4 }));
            });
            // Bass
            const root = chord[0] - 12;
            if (bar >= A.bassFrom) {
                for (let b = 0; b < (groove ? 8 : 2); b++) {
                    const at = t + b * (groove ? BEAT / 2 : BEAT * 2);
                    voice({ f: freq(root - 12), t: at, dur: groove ? BEAT / 2 - 0.02 : BEAT * 2, type: 'triangle', gain: groove ? (b % 2 ? 0.12 : 0.2) : 0.16, cutoff: 600, attack: 0.01, release: 0.1, wet: false });
                }
            }
            // Drums
            if (bar >= A.halfKick[0] && bar < A.halfKick[1]) { kick(t, 0.6); kick(t + 2 * BEAT, 0.6); }
            if (groove) {
                for (let b = 0; b < 4; b++) {
                    kick(t + b * BEAT);
                    hat(t + b * BEAT + BEAT / 2);
                    if (bar >= A.clapFrom) hat(t + b * BEAT + BEAT / 4, 0.05);
                }
                if (bar >= A.clapFrom) { clap(t + BEAT); clap(t + 3 * BEAT); }
            }
            // Plucked arpeggio over the groove, bells on the logo
            if (groove) {
                const notes = [chord[0] + 12, chord[1] + 12, chord[2] + 12, chord[1] + 24];
                for (let i = 0; i < 8; i++) voice({ f: freq(notes[i % 4]), t: t + i * (BEAT / 2), dur: 0.28, type: 'triangle', gain: 0.07, cutoff: 3500, attack: 0.005, release: 0.22, pan: i % 2 ? 0.3 : -0.3 });
            }
            if (brand) chord.forEach((m, i) => voice({ f: freq(m + 24), t: t + i * BEAT * 0.5, dur: 1.4, type: 'sine', gain: 0.06, cutoff: 8000, attack: 0.005, release: 1.2, pan: (i - 1) * 0.5 }));
        });

        // The rise into the logo, and its hit
        const riseFrom = (A.rise - 0.5) * BAR, riseTo = A.rise * BAR;
        const src = ctx.createBufferSource(); src.buffer = noise; src.loop = true;
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2;
        bp.frequency.setValueAtTime(300, riseFrom); bp.frequency.exponentialRampToValueAtTime(7000, riseTo);
        const rg = ctx.createGain(); rg.gain.setValueAtTime(0, riseFrom); rg.gain.linearRampToValueAtTime(0.25, riseTo - 0.05); rg.gain.linearRampToValueAtTime(0, riseTo);
        src.connect(bp).connect(rg).connect(master); src.start(riseFrom); src.stop(riseTo + 0.05);
        A.hits.map((bar) => bar * BAR).forEach((t) => {
            const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(38, t + 1.2);
            const g = ctx.createGain(); g.gain.setValueAtTime(0.8, t); g.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
            o.connect(g).connect(master); o.start(t); o.stop(t + 1.9);
            noiseHit({ t, dur: 0.9, type: 'lowpass', f: 1200, gain: 0.3 });
        });
        return ctx.startRendering();
    }

    window.makeMusic = makeMusic;
    window.MUSIC = { BPM, BAR, ARRANGEMENTS };
})();
