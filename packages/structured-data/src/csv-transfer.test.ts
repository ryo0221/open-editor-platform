import { expect, it } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { type StructuredData, parseCsv } from './model';
import { defaultView, insertRows } from './views';
import { prepareCsvExport, previewCsvAppend } from './csv-transfer';
const data: StructuredData = {
  schemaVersion: 2,
  columns: [
    { id: 'name', name: '名前', type: 'text' },
    { id: 'num', name: '数値', type: 'number' },
    { id: 'select', name: '分類', type: 'select', options: ['採用', '保留'] },
    { id: 'ref', name: '参照', type: 'relation' },
    { id: 'formula', name: '計算', type: 'formula', formula: '[num] * 2' },
  ],
  rows: [
    { id: 'first', values: { name: '日本語,"引用"\n二行', num: 7, select: '採用', ref: null } },
    { id: 'second', values: { name: '別の行', num: 9, select: '保留', ref: 'first' } },
  ],
};
it('exports explicit rows/columns and computes formulas against hidden dependencies with CSV quoting intact', () => {
  const view = defaultView(data);
  view.search = '日本語';
  view.hidden = ['num'];
  const result = prepareCsvExport(data, { rowsScope: 'filtered', columnsScope: 'visible' }, view);
  expect(result.rowIds).toEqual(['first']);
  expect(result.columnIds).toEqual(['name', 'select', 'ref', 'formula']);
  expect(parseCsv(result.csv)).toEqual([
    ['名前', '分類', '参照', '計算'],
    ['日本語,"引用"\n二行', '採用', '', '14'],
  ]);
  expect(prepareCsvExport(data, { rowsScope: 'all', columnsScope: 'all' }, view).rowCount).toBe(2);
  expect(() => prepareCsvExport(data, { rowsScope: 'filtered', columnsScope: 'all' })).toThrow();
});
it('previews all typed append failures at source row/target column and applies only a fully valid batch', () => {
  const before = clone(data);
  const bad = previewCsvAppend(
    data,
    '名前,数値,分類,参照\r\n新規,wrong,未登録,missing\r\n次,2,採用,first\r\n',
    true,
    {},
    ['new-1', 'new-2'],
  );
  expect(bad.columns.map((column) => column?.type)).toEqual([
    'text',
    'number',
    'select',
    'relation',
  ]);
  expect(bad.diagnostics.slice(0, 3).map((error) => [error.row, error.column, error.raw])).toEqual([
    [2, 2, 'wrong'],
    [2, 3, '未登録'],
    [2, 4, 'missing'],
  ]);
  expect(data).toEqual(before);
  const valid = previewCsvAppend(data, '名前,数値,分類,参照\n新規,3,採用,first\n', true, {}, [
    'new-1',
  ]);
  expect(valid.diagnostics).toEqual([]);
  const session = new EditorSession(data);
  session.execute(insertRows(valid.rows));
  expect(session.content.rows).toHaveLength(3);
  expect(session.content.columns).toEqual(data.columns);
  session.undo();
  expect(session.content).toEqual(data);
  session.redo();
  expect(session.content.rows[2].values.ref).toBe('first');
});
it('requires an explicit mapping for unmatched fields and refuses duplicate targets', () => {
  expect(previewCsvAppend(data, 'unknown\nvalue').diagnostics[0].row).toBe(0);
  expect(
    previewCsvAppend(data, 'a,b\nvalue,other', true, { 0: 'name', 1: 'name' }).diagnostics.some(
      (error) => error.message.includes('once'),
    ),
  ).toBe(true);
  expect(previewCsvAppend(data, 'a\n変更', true, { 0: 'name' }).diagnostics).toEqual([]);
});
it('blocks explicit and name-matched formula targets without changing data or writable mappings', () => {
  const before = clone(data);
  for (const [source, targets] of [
    ['source\n99', { 0: 'formula' }],
    ['計算\n99', {}],
  ] as const) {
    const preview = previewCsvAppend(data, source, true, targets, ['new']);
    expect(preview.diagnostics).toContainEqual({
      row: 0,
      column: 1,
      name: '計算',
      columnId: 'formula',
      raw: '',
      message: 'Formula fields are computed; choose an editable target field',
    });
    expect(data).toEqual(before);
  }
  const valid = previewCsvAppend(data, 'source\n99', true, { 0: 'num' }, ['new']);
  expect(valid.diagnostics).toEqual([]);
  const session = new EditorSession(data);
  session.execute(insertRows(valid.rows));
  expect(
    parseCsv(prepareCsvExport(session.content, { rowsScope: 'all', columnsScope: 'all' }).csv)
      .at(-1)
      ?.at(-1),
  ).toBe('198');
  session.undo();
  expect(session.content).toEqual(before);
});
it('diagnoses every trailing value with source coordinates for headed and headerless CSV', () => {
  const before = clone(data);
  const headed = previewCsvAppend(data, '名前,数値\nValid,2\nWide,3,extra,\n', true);
  expect(headed.diagnostics).toEqual([
    {
      row: 3,
      column: 3,
      name: 'Column 3',
      raw: 'extra',
      message: 'Row has more values than the declared source columns',
    },
    {
      row: 3,
      column: 4,
      name: 'Column 4',
      raw: '',
      message: 'Row has more values than the declared source columns',
    },
  ]);
  const headerless = previewCsvAppend(data, 'First,2\nWide,3,extra\n', false, {
    0: 'name',
    1: 'num',
  });
  expect(headerless.diagnostics).toEqual([
    {
      row: 2,
      column: 3,
      name: 'Column 3',
      raw: 'extra',
      message: 'Row has more values than the declared source columns',
    },
  ]);
  expect(data).toEqual(before);
});
it('blocks read-only targets by explicit mapping and name while retaining their defaults', () => {
  const protectedData = clone(data);
  protectedData.columns[0] = {
    ...protectedData.columns[0],
    readOnly: true,
    defaultValue: 'Host default',
  };
  const before = clone(protectedData);
  for (const [source, targets] of [
    ['名前\nHost default', {}],
    ['source\nNew value', { 0: 'name' }],
  ] as const) {
    const preview = previewCsvAppend(protectedData, source, true, targets, ['new']);
    expect(preview.diagnostics).toContainEqual({
      row: 0,
      column: 1,
      name: '名前',
      columnId: 'name',
      raw: '',
      message: 'Read-only fields cannot be imported; choose an editable target field',
    });
    expect(preview.rows[0].values.name).toBe('Host default');
    expect(protectedData).toEqual(before);
  }
  const valid = previewCsvAppend(protectedData, 'source\n3', true, { 0: 'num' }, ['new']);
  expect(valid.diagnostics).toEqual([]);
  expect(valid.rows[0].values).toMatchObject({ name: 'Host default', num: 3 });
});
