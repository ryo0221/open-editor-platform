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
  parseCsvText,
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
  const options = { decodeFormulaGuard: true };
  expect(importCsv(csv, options).columns.map((column) => column.name)).toEqual([
    '-Notes',
    'State',
    'N',
  ]);
  expect(Object.values(importCsv(csv, options).rows[0].values)).toEqual(['- todo', '- none -', -4]);
  const appended = previewCsvAppend(data, csv, true, {}, ['copy'], options);
  expect(appended.diagnostics).toEqual([]);
  expect(appended.rows[0].values).toEqual(data.rows[0].values);
});

it('preserves external literal apostrophes in parsing, replace and append imports', () => {
  const values = ["'=pending", "'- none -", "''-x", "'@x", "'+cmd", "'\tvalue", "'plain"];
  const source = "'Header,Text\r\n" + values.map((v) => `plain,${v}`).join('\r\n');
  expect(parseCsvText('\uFEFF' + source)).toEqual([
    ["'Header", 'Text'],
    ...values.map((v) => ['plain', v]),
  ]);
  const imported = importCsv(source);
  expect(imported.columns.map((c) => c.name)).toEqual(["'Header", 'Text']);
  expect(imported.rows.map((r) => r.values[imported.columns[1].id])).toEqual(values);
  const append = previewCsvAppend({ ...imported, rows: [] }, source);
  expect(append.diagnostics).toEqual([]);
  expect(append.rows.map((r) => r.values[imported.columns[1].id])).toEqual(values);
});

it('round-trips guarded headers and values only with explicit decoding, without weakening exports', () => {
  const values = [
    '=1+1',
    '+cmd',
    '- todo',
    '@SUM(A1)',
    '\tvalue',
    '\rvalue',
    "'=pending",
    "''-x",
    "'plain",
    'a,b',
    'line\nbreak',
    '"quoted"',
  ];
  const data: StructuredData = {
    schemaVersion: 2,
    columns: [{ id: 'text', name: "'=Header", type: 'text' }],
    rows: values.map((value, i) => ({ id: String(i), values: { text: value } })),
  };
  for (const source of [
    exportCsv(data),
    prepareCsvExport(data, { rowsScope: 'all', columnsScope: 'all' }).csv,
  ]) {
    const options = { decodeFormulaGuard: true };
    expect(parseCsvText(source, options)).toEqual([["'=Header"], ...values.map((v) => [v])]);
    expect(parseCsvText(source)).toEqual(parseCsv(source));
    const replaced = importCsv(source, options);
    expect(replaced.columns[0].name).toBe("'=Header");
    expect(replaced.rows.map((r) => r.values[replaced.columns[0].id])).toEqual(values);
    const appended = previewCsvAppend(data, source, true, {}, [], options);
    expect(appended.diagnostics).toEqual([]);
    expect(appended.rows.map((r) => r.values.text)).toEqual(values);
    expect(parseCsv(source)[1][0]).toBe("'=1+1");
    expect(exportCsv(replaced)).toBe(source);
  }
});
