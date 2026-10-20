import { expect, it } from 'vitest';
import { deepFreeze } from '@editor-platform/artifact-core';
import {
  cellValue,
  csvField,
  csvText,
  displayCell,
  exportCsv,
  importCsv,
  parseCsv,
  validateData,
  type Column,
  type StructuredData,
} from './model';
import { prepareCsvExport, previewCsvAppend } from './csv-transfer';

/** F1 = F0+F0, F2 = F1+F1, ...; each column references the previous one twice. */
function doublingChain(depth: number, onEvaluate?: () => void): StructuredData {
  const columns: Column[] = [{ id: 'f0', name: 'F0', type: 'number' }];
  for (let i = 1; i <= depth; i++) {
    const column: Column = {
      id: `f${i}`,
      name: `F${i}`,
      type: 'formula',
      formula: `F${i - 1}+F${i - 1}`,
    };
    columns.push(
      onEvaluate
        ? new Proxy(column, {
            get(target, key) {
              if (key === 'formula') onEvaluate();
              return Reflect.get(target, key);
            },
          })
        : column,
    );
  }
  return { schemaVersion: 2, columns, rows: [{ id: 'row', values: { f0: 1 } }] };
}

it('evaluates each referenced formula once per row instead of once per reference path', () => {
  let evaluations = 0;
  const data = doublingChain(24, () => evaluations++);
  expect(cellValue(data, data.rows[0], data.columns[24])).toBe(2 ** 24);
  expect(evaluations).toBe(24);
});

it('shares formula results across calls for immutable data', () => {
  let evaluations = 0;
  const data = deepFreeze(doublingChain(30, () => evaluations++));
  const row = data.rows[0];
  evaluations = 0; // deepFreeze reads every property once
  expect(cellValue(data, row, data.columns[30])).toBe(2 ** 30);
  expect(evaluations).toBe(30);
  for (const column of data.columns) displayCell(data, row, column);
  expect(validateData(data)).toEqual([]);
  expect(evaluations).toBe(30);
});

it('still reports circular, unknown and non-numeric references', () => {
  const data: StructuredData = {
    schemaVersion: 2,
    columns: [
      { id: 'a', name: 'A', type: 'formula', formula: 'B+1' },
      { id: 'b', name: 'B', type: 'formula', formula: 'A+1' },
      { id: 'c', name: 'C', type: 'formula', formula: 'Missing+1' },
      { id: 't', name: 'T', type: 'text' },
      { id: 'd', name: 'D', type: 'formula', formula: 'T+1' },
      { id: 'e', name: 'E', type: 'formula', formula: 'D+D' },
    ],
    rows: [{ id: 'row', values: { t: 'text' } }],
  };
  const messages = Object.fromEntries(
    validateData(data).map((error) => [error.columnId, error.message]),
  );
  expect(messages).toEqual({
    a: 'Circular formula',
    b: 'Circular formula',
    c: 'Unknown column: Missing',
    d: 'T is not numeric',
    e: 'T is not numeric',
  });
  expect(displayCell(data, data.rows[0], data.columns[5])).toBe('#ERROR');
});

it('neutralizes spreadsheet formulas in exported CSV fields and keeps numbers intact', () => {
  expect(csvField('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
  for (const value of ['+cmd', '-2+3', '@SUM(A1)', '\tvalue', '\rvalue'])
    expect(csvField(value).replace(/^"/, '')).toMatch(/^'/);
  for (const value of ['-5', '+3', '-0.25', '1e-3', 'plain', '', 'a=b'])
    expect(csvField(value)).toBe(value);
  expect(csvField('a,b')).toBe('"a,b"');
  expect(csvField('\uFEFF=1+1')).toBe("'\uFEFF=1+1");
});

it('applies the same CSV field encoding to both export paths', () => {
  const data: StructuredData = {
    schemaVersion: 2,
    columns: [
      { id: 'name', name: '=Name', type: 'text' },
      { id: 'n', name: 'N', type: 'number' },
    ],
    rows: [{ id: 'row', values: { name: '=1+1', n: -4 } }],
  };
  const expected = [
    ["'=Name", 'N'],
    ["'=1+1", '-4'],
  ];
  expect(parseCsv(exportCsv(data))).toEqual(expected);
  expect(parseCsv(prepareCsvExport(data, { rowsScope: 'all', columnsScope: 'all' }).csv)).toEqual(
    expected,
  );
});

it("round-trips guarded values through this editor's own CSV import", () => {
  const values = ['=1+1', '- todo', '-', '-5', "'=already quoted", "''-x", "'plain", '\uFEFF@x'];
  for (const value of values) expect(csvText(parseCsv(csvField(value))[0][0])).toBe(value);
  const data: StructuredData = {
    schemaVersion: 2,
    columns: [
      { id: 'notes', name: '-Notes', type: 'text' },
      { id: 'state', name: 'State', type: 'select', options: ['-', '- none -'] },
      { id: 'n', name: 'N', type: 'number' },
    ],
    rows: [{ id: 'row', values: { notes: '- todo', state: '- none -', n: -4 } }],
  };
  const csv = exportCsv(data);
  expect(importCsv(csv).columns.map((column) => column.name)).toEqual(['-Notes', 'State', 'N']);
  expect(Object.values(importCsv(csv).rows[0].values)).toEqual(['- todo', '- none -', -4]);
  const appended = previewCsvAppend(data, csv, true, {}, ['copy']);
  expect(appended.diagnostics).toEqual([]);
  expect(appended.rows[0].values).toEqual(data.rows[0].values);
});
