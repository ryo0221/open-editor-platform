import { expect, it } from 'vitest';
import { deepFreeze } from '@editor-platform/artifact-core';
import { command, immutableCommand } from '@editor-platform/editor-core';
import type { StructuredData } from './model';
import { setCells } from './views';
import { assertDataReadable, DataSession, guardDataCommand } from './session';

function fixture(): StructuredData {
  return {
    schemaVersion: 2,
    columns: [
      { id: 'amount', name: 'Amount', type: 'number' },
      { id: 'locked', name: 'Locked', type: 'text', readOnly: true },
      { id: 'total', name: 'Total', type: 'formula', formula: 'Amount * 2' },
    ],
    rows: [
      { id: 'one', values: { amount: 3, locked: 'retained' } },
      { id: 'two', values: { amount: 4, locked: 'retained' } },
    ],
  };
}

it.each([false, true])(
  'rechecks mutable cell values after readable validation (shallow freeze: %s)',
  (shallow) => {
    const current = fixture();
    if (shallow) {
      Object.freeze(current);
      current.rows.forEach(Object.freeze);
    }
    assertDataReadable(current);
    current.rows[0].values.amount = Infinity;
    expect(() => assertDataReadable(current)).toThrow('finite');
    current.rows[0].values.amount = 3;
    current.rows[1].values.amount = NaN;
    expect(() => assertDataReadable(current)).toThrow('finite');
    current.rows[1].values.amount = 4;
    const next = guardDataCommand(
      immutableCommand<StructuredData>('copy', 'Copy', (value) => ({ ...value })),
    ).apply(current);
    next.rows[0].values.amount = 99;
    expect(current.rows[0].values.amount).toBe(3);
  },
);

it('checks new and changed rows after certifying unchanged finite rows', () => {
  const current = deepFreeze(fixture());
  assertDataReadable(current);
  assertDataReadable(current);
  const changed = {
    ...current,
    rows: [
      { ...current.rows[0], values: { ...current.rows[0].values, amount: Infinity } },
      current.rows[1],
    ],
  };
  const added = { ...current, rows: [...current.rows, { id: 'new', values: { amount: NaN } }] };
  expect(() => assertDataReadable(changed)).toThrow('finite');
  expect(() => assertDataReadable(added)).toThrow('finite');
  expect(() => assertDataReadable(current)).not.toThrow();
});

it('retains current permissions and protected fields through immutable preflight and submission', () => {
  const session = new DataSession(fixture());
  let writable = true;
  const guarded = guardDataCommand(
    setCells([{ rowId: 'one', columnId: 'amount', value: 7 }]),
    () => writable,
  );
  const before = session.content;
  expect(guarded.apply(before).rows[0].values.amount).toBe(7);
  expect(before).toEqual(fixture());
  session.executeView(guarded);
  const accepted = session.content,
    revision = session.revision;
  writable = false;
  expect(() => session.executeView(guarded)).toThrow('read only');
  writable = true;
  expect(() =>
    session.executeView(
      immutableCommand<StructuredData>('forged', 'Forge protected value', (current) => ({
        ...current,
        rows: current.rows.map((row) =>
          row.id === 'one' ? { ...row, values: { ...row.values, locked: 'bypass' } } : row,
        ),
      })),
    ),
  ).toThrow('read only');
  expect(session.content).toEqual(accepted);
  expect(session.revision).toEqual(revision);
  expect(session.undo()).toEqual(fixture());
  expect(session.redo()).toEqual(accepted);
});

it('isolates mutating commands that throw, including forged read-only declarations', () => {
  const initial = fixture(),
    session = new DataSession(initial);
  const mutating = command<StructuredData>('mutate', 'Mutate then throw', (current) => {
    current.rows[0].values.amount = 99;
    throw new Error('abort');
  });
  expect(() => guardDataCommand(mutating).apply(initial)).toThrow('abort');
  expect(() => session.executeView(mutating)).toThrow('abort');
  expect(() =>
    session.executeView(
      immutableCommand<StructuredData>('forged-readonly', 'Mutate canonical input', (current) => {
        current.rows[0].values.amount = 99;
        return current;
      }),
    ),
  ).toThrow();
  expect(initial).toEqual(fixture());
  expect(session.content).toEqual(fixture());
  expect(session.canUndo).toBe(false);
  expect(session.revision.sequence).toBe(0);
});
