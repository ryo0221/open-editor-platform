import { expect, it } from 'vitest';
import { canonicalJson } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { createData, displayCell, type StructuredData } from './model';
import { prepareRecordDrafts, RecordDraftError, type RecordDraft } from './record-draft';
const fixture = () => ({
  ...createData(),
  columns: [
    { id: 'name', name: 'Name', type: 'text' as const },
    { id: 'amount', name: 'Amount', type: 'number' as const },
  ],
  rows: [
    { id: 'a', values: { name: 'First', amount: 1 } },
    { id: 'b', values: { name: 'Second', amount: 2 } },
  ],
});
function draft(
  data: ReturnType<typeof fixture>,
  id: string,
  patch: Record<string, string>,
): RecordDraft {
  const row = data.rows.find((row) => row.id === id)!;
  return {
    base: canonicalJson(row),
    columns: canonicalJson(data.columns),
    values: {
      ...Object.fromEntries(
        data.columns.map((column) => [column.id, displayCell(data, row, column)]),
      ),
      ...patch,
    },
  };
}
it('flushes hidden record drafts together with one undo and validates their source pins', () => {
  const data = fixture(),
    session = new EditorSession<StructuredData>(data);
  const buffers = new Map([
    ['a', draft(data, 'a', { name: 'Edited First' })],
    ['b', draft(data, 'b', { amount: '42' })],
  ]);
  const edit = prepareRecordDrafts(data, buffers);
  session.execute(edit);
  expect(session.content.rows[0].values.name).toBe('Edited First');
  expect(session.content.rows[1].values.amount).toBe(42);
  expect(session.undo()).toEqual(data);
  const stale = structuredClone(data);
  stale.rows[1].values.amount = 9;
  expect(() => edit.apply(stale)).toThrow('変更されました');
});
it('rejects invalid or composing input without returning a save command', () => {
  const data = fixture(),
    invalid = draft(data, 'a', { amount: 'not a number' });
  expect(() => prepareRecordDrafts(data, new Map([['a', invalid]]))).toThrow();
  expect(() =>
    prepareRecordDrafts(data, new Map([['a', { ...invalid, composing: true }]])),
  ).toThrow('入力変換');
  const missing = structuredClone(data);
  missing.rows = [];
  expect(() => prepareRecordDrafts(missing, new Map([['a', invalid]]))).toThrow('変更されています');
  const invalidSecond = () =>
    prepareRecordDrafts(
      data,
      new Map([
        ['a', draft(data, 'a', { name: 'Valid first' })],
        ['b', draft(data, 'b', { amount: 'invalid' })],
      ]),
    );
  expect(invalidSecond).toThrow(RecordDraftError);
  try {
    invalidSecond();
  } catch (error) {
    expect(error).toBeInstanceOf(RecordDraftError);
    expect((error as RecordDraftError).rowId).toBe('b');
  }
});
