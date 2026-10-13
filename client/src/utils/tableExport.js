// Excel exports of the comparison tables (farms, active ingredients): rows built here, written
// with the lazily loaded writer. One sheet per table; headers bold and kept in view.
import { loadExcelWriter } from '@/utils/lazyLibs';

const header = (labels) => labels.map((value) => ({ value, fontWeight: 'bold', wrap: true }));
// Empty cell for an unknown value, never "null"
const cell = (value) => (value === null || value === undefined ? '' : value);
const day = (value) => (value ? new Date(value).toISOString().slice(0, 10) : '');

/** Farms and their plots, as two sheets. */
export function farmCompareSheets(farms, period, t) {
  const farmRows = farms.map((f) => [
    f.name, f.traps, cell(f.ftd), cell(f.previousFtd), cell(f.changePct),
    f.worstPlot ? `${f.worstPlot.name} (${f.worstPlot.ftd})` : '', f.treatments
  ]);
  const plotRows = farms.flatMap((f) => f.plots.map((p) => [f.name, p.name, p.traps, cell(p.ftd), cell(p.changePct)]));
  return [
    {
      name: t('farms.compare.sheetFarms', { days: period }),
      rows: [header([t('farms.compare.farm'), t('farms.compare.trapsCol'), t('farms.compare.ftd'), t('farms.compare.previousFtd'),
        t('farms.compare.changePctCol'), t('farms.compare.worstPlot'), t('farms.compare.treatments')]), ...farmRows],
      widths: [28, 10, 16, 16, 16, 26, 12]
    },
    {
      name: t('farms.compare.sheetPlots'),
      rows: [header([t('farms.compare.farm'), t('farms.compare.plot'), t('farms.compare.trapsCol'), t('farms.compare.ftd'),
        t('farms.compare.changePctCol')]), ...plotRows],
      widths: [28, 24, 10, 16, 16]
    }
  ];
}

/** Active ingredients and their effect, as one sheet. */
export function ingredientSheets(groups, t) {
  const rows = groups.map((g) => [
    g.name, g.products.join(', '), g.uses, g.measured, cell(g.avgChangePct), g.measured ? g.effective : '', day(g.lastAt)
  ]);
  return [{
    name: t('logbook.byIngredient.sheetName'),
    rows: [header([t('logbook.byIngredient.name'), t('logbook.byIngredient.products'), t('logbook.byIngredient.uses'),
      t('logbook.byIngredient.measured'), t('logbook.byIngredient.avgChangePct'), t('logbook.byIngredient.clearlyWorked'),
      t('logbook.byIngredient.last')]), ...rows],
    widths: [28, 28, 10, 12, 18, 16, 14]
  }];
}

/** Write sheets ([{ name, rows, widths }]) to an .xlsx download. */
export async function downloadSheets(fileName, sheets) {
  const write = await loadExcelWriter();
  await write(sheets.map((s) => ({
    data: s.rows,
    // Excel limits sheet names to 31 characters
    sheet: s.name.slice(0, 31),
    columns: s.widths.map((width) => ({ width })),
    stickyRowsCount: 1
  }))).toFile(fileName);
}
