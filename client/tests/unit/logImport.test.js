import { describe, it, expect } from 'vitest';
import { fold, parseCsv, parseDate, parseType, parseCameras, mapHeader, toImportRows, templateCsv } from '@/utils/logImport';

const cameras = [
  { deviceSerial: 'BC1001', deviceName: 'Bẫy xoài A1' },
  { deviceSerial: 'BC1002', deviceName: 'Bẫy xoài A2' }
];
const labelsByType = { spray: ['Phun thuốc', 'Spray'], bait: ['Bả protein', 'Protein bait'] };

describe('field log import', () => {
  it('folds Vietnamese text for matching', () => {
    expect(fold('Ngày phun')).toBe('ngay phun');
    expect(fold('  Đường đi ')).toBe('duong di');
  });

  it('reads CSV with quotes, line breaks and either delimiter', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
    expect(parseCsv('﻿a;b\r\n1;"two\nlines"\r\n\r\n')).toEqual([['a', 'b'], ['1', 'two\nlines']]);
  });

  it('reads dates day first, ISO, or from Excel; rejects impossible ones', () => {
    expect(parseDate('13/10/2026 06:30')).toEqual(new Date(2026, 9, 13, 6, 30));
    expect(parseDate('2026-10-13')).toEqual(new Date(2026, 9, 13, 7, 0));
    const excel = new Date(2026, 0, 2);
    expect(parseDate(excel)).toBe(excel);
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate('last week')).toBeNull();
  });

  it('matches types and traps by name or serial, in any case and accents', () => {
    expect(parseType('phun thuoc', labelsByType)).toBe('spray');
    expect(parseType('Spray', labelsByType)).toBe('spray');
    expect(parseType('bait', labelsByType)).toBe('bait');
    expect(parseType('flood', labelsByType)).toBeNull();
    expect(parseCameras('bay xoai a1; BC1002, Bẫy xoài A1', cameras)).toEqual({ serials: ['BC1001', 'BC1002'], unknown: [] });
    expect(parseCameras('A9', cameras)).toEqual({ serials: [], unknown: ['A9'] });
  });

  it('maps headers in either language', () => {
    expect(mapHeader(['Ngày', 'Biện pháp', 'Bẫy', 'Thuốc', 'Hoạt chất', 'Cách ly', 'Ghi chú', 'Something'])).toEqual(
      ['date', 'type', 'cameras', 'product', 'activeIngredient', 'preHarvestDays', 'note', null]);
    expect(mapHeader(['Date', 'Type', 'Traps', 'Product'])).toEqual(['date', 'type', 'cameras', 'product']);
  });

  it('turns a sheet into rows, with the problems of each line', () => {
    const sheet = [
      ['Ngày', 'Biện pháp', 'Bẫy', 'Thuốc', 'Cách ly'],
      ['13/10/2026', 'Phun thuốc', 'Bẫy xoài A1, Bẫy xoài A2', 'Radiant 60SC', '7'],
      ['32/10/2026', 'Tưới nước', 'A9', '', 'bảy']
    ];
    const { missing, rows } = toImportRows(sheet, { cameras, labelsByType });
    expect(missing).toEqual([]);
    expect(rows[0].line).toBe(2);
    expect(rows[0].problems).toEqual([]);
    expect(rows[0].body).toMatchObject({ type: 'spray', cameraSerials: ['BC1001', 'BC1002'], product: 'Radiant 60SC', preHarvestDays: 7 });
    expect(rows[1].problems.map((p) => p.key)).toEqual(['badDate', 'badType', 'unknownTraps', 'badPhi']);
    expect(toImportRows([['Thuốc', 'Ghi chú']], { cameras, labelsByType }).missing).toEqual(['date', 'type', 'cameras']);
  });

  it('writes a template Excel opens as UTF-8', () => {
    const csv = templateCsv(['Ngày', 'Bẫy'], ['13/10/2026', 'Bẫy xoài A1, Bẫy xoài A2']);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('"Bẫy xoài A1, Bẫy xoài A2"');
  });
});
