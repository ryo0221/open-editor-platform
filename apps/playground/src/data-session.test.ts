import { expect, it } from 'vitest';
import { command, type EditorCommand } from '@editor-platform/editor-core';
import { createDesign } from '@editor-platform/design/model';
import { setCells } from '@editor-platform/structured-data/views';
import type { StructuredData } from '@editor-platform/structured-data/model';
import { createLocalSession, type Content } from './model';

const fixture = (): StructuredData => ({
  schemaVersion: 2,
  columns: [{ id: 'amount', name: 'Amount', type: 'number' }],
  rows: [{ id: 'record', values: { amount: 3 } }],
});

it('keeps the Host Data domain and finite-cell boundary through immutable edits and history', () => {
  const session = createLocalSession(fixture());
  session.executeView(
    setCells([{ rowId: 'record', columnId: 'amount', value: 7 }]) as EditorCommand<Content>,
  );
  const accepted = session.content,
    revision = session.revision;
  expect(() =>
    session.executeView(command<Content>('swap', 'Change domain', () => createDesign())),
  ).toThrow('Invalid Data');
  expect(() =>
    session.executeView(
      command<Content>('nonfinite', 'Corrupt cell', (current) => {
        (current as StructuredData).rows[0].values.amount = Infinity;
        return current;
      }),
    ),
  ).toThrow('finite');
  expect(session.content).toEqual(accepted);
  expect(session.revision).toEqual(revision);
  expect(session.undo()).toEqual(fixture());
  expect(session.redo()).toEqual(accepted);
});

it('keeps mutable Host inputs and exported snapshots independent of Data history', () => {
  const input = fixture(),
    session = createLocalSession(input);
  input.rows[0].values.amount = 99;
  expect(session.content).toEqual(fixture());
  session.executeView(
    setCells([{ rowId: 'record', columnId: 'amount', value: 7 }]) as EditorCommand<Content>,
  );
  const exported = session.content as StructuredData;
  exported.rows[0].values.amount = 101;
  expect((session.content as StructuredData).rows[0].values.amount).toBe(7);
  expect(session.undo()).toEqual(fixture());
  expect((session.redo() as StructuredData).rows[0].values.amount).toBe(7);
});
