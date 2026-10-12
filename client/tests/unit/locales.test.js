import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { baseCompile } from '@intlify/message-compiler';
import en from '@/locales/en.json';
import vi from '@/locales/vi.json';

// key -> value for every leaf; groups are listed too, as t() may point at one
const entries = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) =>
  v && typeof v === 'object' ? [[prefix + k, v], ...entries(v, `${prefix}${k}.`)] : [[prefix + k, v]]);
const leaves = (obj) => Object.fromEntries(entries(obj).filter(([, v]) => typeof v === 'string'));
const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

const EN = leaves(en);
const VI = leaves(vi);

describe('translations', () => {
  it('both languages have the same keys', () => {
    expect(Object.keys(VI).filter(k => !(k in EN))).toEqual([]);
    expect(Object.keys(EN).filter(k => !(k in VI))).toEqual([]);
  });

  it('both languages use the same placeholders', () => {
    const differ = Object.keys(VI).filter(k => k in EN && placeholders(VI[k]).join() !== placeholders(EN[k]).join());
    expect(differ).toEqual([]);
  });

  it('every message compiles (an @ or | must be escaped)', () => {
    const broken = [];
    for (const [lang, messages] of [['vi', VI], ['en', EN]]) {
      for (const [key, text] of Object.entries(messages)) {
        baseCompile(text, { onError: (err) => broken.push(`${lang} ${key}: ${err.message}`) });
      }
    }
    expect(broken).toEqual([]);
  });

  it('every t(\'...\') key in the code exists', () => {
    const keys = new Set(entries(en).map(([k]) => k));
    const files = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        if (fs.statSync(file).isDirectory()) walk(file);
        else if (/\.(vue|js)$/.test(name)) files.push(file);
      }
    };
    walk(path.resolve(__dirname, '../../src'));
    const missing = [];
    for (const file of files) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/\bt\(\s*'([a-zA-Z][\w.]*)'/g)) {
        if (!keys.has(m[1])) missing.push(`${path.basename(file)}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
