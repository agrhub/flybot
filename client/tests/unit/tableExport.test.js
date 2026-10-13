import { describe, it, expect } from 'vitest';
import { farmCompareSheets, ingredientSheets } from '@/utils/tableExport';

const t = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key);
const values = (row) => row.map((c) => (typeof c === 'object' && c !== null ? c.value : c));

describe('Excel exports of the comparison tables', () => {
  it('farms and plots, unknown values left empty', () => {
    const farms = [
      { name: 'Mango', traps: 2, ftd: 6, previousFtd: 4, changePct: 50, worstPlot: { name: 'Plot A', ftd: 10 }, treatments: 3,
        plots: [{ name: 'Plot A', traps: 1, ftd: 10, changePct: 150 }, { name: 'Plot B', traps: 1, ftd: null, changePct: null }] },
      { name: 'Empty', traps: 0, ftd: null, previousFtd: null, changePct: null, worstPlot: null, treatments: 0, plots: [] }
    ];
    const [farmSheet, plotSheet] = farmCompareSheets(farms, 30, t);
    expect(farmSheet.name).toBe('farms.compare.sheetFarms:{"days":30}');
    expect(farmSheet.rows[0][0]).toEqual({ value: 'farms.compare.farm', fontWeight: 'bold', wrap: true });
    expect(values(farmSheet.rows[1])).toEqual(['Mango', 2, 6, 4, 50, 'Plot A (10)', 3]);
    expect(values(farmSheet.rows[2])).toEqual(['Empty', 0, '', '', '', '', 0]);
    expect(plotSheet.rows.slice(1)).toEqual([['Mango', 'Plot A', 1, 10, 150], ['Mango', 'Plot B', 1, '', '']]);
    expect(farmSheet.widths.length).toBe(farmSheet.rows[0].length);
    expect(plotSheet.widths.length).toBe(plotSheet.rows[0].length);
  });

  it('active ingredients, with no "clearly worked" count when nothing was measured', () => {
    const [sheet] = ingredientSheets([
      { name: 'Spinetoram', products: ['Radiant 60SC'], uses: 2, measured: 1, effective: 1, avgChangePct: -67, lastAt: '2026-10-11T00:00:00Z' },
      { name: 'Methyl eugenol', products: [], uses: 1, measured: 0, effective: 0, avgChangePct: null, lastAt: '2026-09-21T09:00:00Z' }
    ], t);
    expect(sheet.rows.slice(1)).toEqual([
      ['Spinetoram', 'Radiant 60SC', 2, 1, -67, 1, '2026-10-11'],
      ['Methyl eugenol', '', 1, 0, '', '', '2026-09-21']
    ]);
    expect(sheet.widths.length).toBe(sheet.rows[0].length);
  });
});
