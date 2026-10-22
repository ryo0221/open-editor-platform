import { expect, it } from 'vitest';
import { importCsv } from './model';
import { csvWithFormulaGuard, csvWithHeader, retypeCsvColumn, type CsvDraft } from './view-model';

for (const header of [true, false]) {
  it(`preserves preview types while toggling guard decoding with header=${header}`, () => {
    const source = `${header ? 'Date,Count,Note,Number,Flag\n' : ''}2026-10-21,100,'=1+1,2.5,true\n`;
    let csv: CsvDraft = csvWithHeader({ source, data: importCsv(source), name: 'own.csv' }, header);
    csv = retypeCsvColumn(csv, csv.data.columns[0], 'date', header);
    csv = retypeCsvColumn(csv, csv.data.columns[1], 'text', header);
    for (const decode of [true, false, true]) {
      csv = csvWithFormulaGuard(csv, decode, header);
      expect(csv.data.columns.map((c) => c.type)).toEqual([
        'date',
        'text',
        'text',
        'number',
        'boolean',
      ]);
      expect(Object.values(csv.data.rows[0].values)).toEqual([
        '2026-10-21',
        '100',
        decode ? '=1+1' : "'=1+1",
        2.5,
        true,
      ]);
      // Retyping after toggling must read the same decoded source as the preview.
      csv = retypeCsvColumn(csv, csv.data.columns[2], 'text', header);
      expect(csv.data.rows[0].values[csv.data.columns[2].id]).toBe(decode ? '=1+1' : "'=1+1");
    }
  });
}

it('matches import header normalization while retaining column and row identities', () => {
  const source = "'=Header, =Header , ,=Header\n1,2,3,4\n";
  let csv: CsvDraft = { source, data: importCsv(source), name: 'headers.csv' };
  const columnIds = csv.data.columns.map((c) => c.id);
  const rowIds = csv.data.rows.map((r) => r.id);
  for (const decodeFormulaGuard of [true, false]) {
    csv = csvWithFormulaGuard(csv, decodeFormulaGuard, true);
    expect(csv.data.columns.map((c) => c.name)).toEqual(
      importCsv(source, { decodeFormulaGuard }).columns.map((c) => c.name),
    );
    expect(csv.data.columns.map((c) => c.id)).toEqual(columnIds);
    expect(csv.data.rows.map((r) => r.id)).toEqual(rowIds);
    expect(Object.values(csv.data.rows[0].values)).toEqual([1, 2, 3, 4]);
  }
});
