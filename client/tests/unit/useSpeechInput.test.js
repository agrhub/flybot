import { describe, it, expect, vi, afterEach } from 'vitest';

// A stand-in for the browser's recognizer
class FakeRecognition {
  static last = null;
  constructor() { FakeRecognition.last = this; }
  start() { this.started = true; }
  stop() { this.onend?.(); }
  abort() {}
  say(...phrases) {
    const results = phrases.map(([text, isFinal]) => Object.assign([{ transcript: text }], { isFinal }));
    this.onresult({ results });
  }
}

afterEach(() => {
  delete window.SpeechRecognition;
  vi.resetModules();
});

describe('voice input', () => {
  it('is offered only where the browser can recognize speech', async () => {
    const { useSpeechInput } = await import('@/composables/useSpeechInput');
    expect(useSpeechInput().supported).toBe(false);
  });

  it('listens in the chosen language and passes the words on, then stops', async () => {
    window.SpeechRecognition = FakeRecognition;
    const { useSpeechInput } = await import('@/composables/useSpeechInput');
    const speech = useSpeechInput();
    const heard = [];
    const errors = [];
    speech.start({ language: 'vi', onText: (text, final) => heard.push([text, final]), onError: (c) => errors.push(c) });
    const rec = FakeRecognition.last;
    expect(rec.lang).toBe('vi-VN');
    expect(speech.listening.value).toBe(true);
    rec.say(['sáng nay phun', false]);
    rec.say(['sáng nay phun', true], [' Radiant cho lô xoài A', true]);
    expect(heard).toEqual([['sáng nay phun', false], ['sáng nay phun Radiant cho lô xoài A', true]]);
    rec.onerror({ error: 'not-allowed' });
    rec.onerror({ error: 'aborted' });
    expect(errors).toEqual(['denied']);
    speech.stop();
    expect(speech.listening.value).toBe(false);
  });
});
