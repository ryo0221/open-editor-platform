import { expect, it } from 'vitest';
import { canonicalJson } from '@editor-platform/artifact-core';
import { command } from '@editor-platform/editor-core';
import { createData, addRow, makeRow, removeColumn, type StructuredData } from './model';
import { insertRows, setCells, updateColumn } from './views';
import { DataSession, pinDataCommand } from './session';
it('allows a previewed formula-to-value migration but refuses forged commands and protected formulas', () => {
  const initial: StructuredData = {
    schemaVersion: 2,
    columns: [{ id: 'computed', name: 'Computed', type: 'formula', formula: '21 * 2' }],
    rows: [{ id: 'r', values: {} }],
  };
  const session = new DataSession(initial),
    migration = updateColumn('computed', { type: 'number' });
  session.execute(migration);
  expect(session.content.rows[0].values.computed).toBe(42);
  expect(session.undo()).toEqual(initial);
  expect(session.redo().rows[0].values.computed).toBe(42);
  const forged = new DataSession(initial);
  expect(() =>
    forged.execute(command('data.column.update', 'Forged conversion', migration.apply)),
  ).toThrow('read only');
  const protectedData = structuredClone(initial);
  protectedData.columns[0].readOnly = true;
  expect(() => new DataSession(protectedData).execute(migration)).toThrow('read only');
  expect(forged.content).toEqual(initial);
});
it('checks protected defaults and omitted formula values on every added row, with atomic refusal and Undo', () => {
  const initial = createData(),
    column = initial.columns[0],
    formula = initial.columns.find((c) => c.type === 'formula')!;
  column.readOnly = true;
  const session = new DataSession(initial);
  session.execute(addRow());
  expect(session.content.rows[0].values[column.id]).toBe(column.defaultValue);
  expect(Object.hasOwn(session.content.rows[0].values, formula.id)).toBe(false);
  expect(session.undo()).toEqual(initial);
  session.execute(insertRows([makeRow(initial, 'allowed')]));
  expect(session.undo()).toEqual(initial);
  const revision = session.revision,
    history = [session.canUndo, session.canRedo];
  for (const [id, value] of [
    [column.id, 'CSV bypass'],
    [formula.id, 99],
    [formula.id, null],
  ] as const) {
    const row = makeRow(initial, 'bad');
    row.values[id] = value;
    expect(() => session.execute(insertRows([makeRow(initial, 'good'), row]))).toThrow(
      /read-only|formula/,
    );
    expect(session.content).toEqual(initial);
    expect(session.revision).toEqual(revision);
    expect([session.canUndo, session.canRedo]).toEqual(history);
  }
  expect(() =>
    session.execute(
      command('headless', 'Insert protected values', (d) => ({
        ...d,
        rows: [
          {
            ...makeRow(d, 'forged'),
            values: { ...makeRow(d, 'forged').values, [column.id]: 'Bypass' },
          },
        ],
      })),
    ),
  ).toThrow('read-only');
  expect(session.content).toEqual(initial);
  expect(session.revision).toEqual(revision);
});
it('also checks newly introduced protected columns while retaining readable legacy values and normal Graph defaults', () => {
  const initial = addRow().apply(createData()),
    column = initial.columns[0];
  column.readOnly = true;
  initial.rows[0].values[column.id] = 'Retained legacy value';
  const session = new DataSession(initial);
  session.execute(addRow());
  expect(session.content.rows[0].values[column.id]).toBe('Retained legacy value');
  expect(session.content.rows[1].values[column.id]).toBe(column.defaultValue);
  expect(session.undo()).toEqual(initial);
  const revision = session.revision;
  expect(() =>
    session.execute(
      command('new-schema', 'Schema and bad row', (d) => {
        const next = {
          ...d,
          columns: [
            ...d.columns,
            {
              id: 'protected',
              name: 'Protected',
              type: 'text' as const,
              readOnly: true,
              defaultValue: 'Default',
            },
          ],
        };
        const row = makeRow(next, 'bad');
        row.values.protected = 'Bypass';
        return { ...next, rows: [...next.rows, row] };
      }),
    ),
  ).toThrow('read-only');
  expect(session.content).toEqual(initial);
  expect(session.revision).toEqual(revision);
});
it('pins all input-buffer commits to the original row and schema, including trusted headless commands', () => {
  const initial = addRow().apply(createData()),
    session = new DataSession(initial),
    row = initial.rows[0],
    column = initial.columns[0];
  const cmd = pinDataCommand(
    setCells([{ rowId: row.id, columnId: column.id, value: 'Old buffer' }]),
    { rowId: row.id, row: canonicalJson(row), columns: canonicalJson(initial.columns) },
  );
  session.execute(setCells([{ rowId: row.id, columnId: column.id, value: 'New source' }]));
  const before = session.content,
    revision = session.revision;
  expect(() => session.execute(cmd)).toThrow('changed');
  expect(session.content).toEqual(before);
  expect(session.revision).toEqual(revision);
  const schemaSession = new DataSession(initial);
  schemaSession.execute(
    command('schema', 'Schema', (d) => ({
      ...d,
      columns: d.columns.map((c) => (c.id === column.id ? { ...c, name: 'Renamed field' } : c)),
    })),
  );
  expect(() => schemaSession.execute(cmd)).toThrow('schema');
});
it('prunes graph label settings on column removal and refuses finite-number corruption', () => {
  const d = addRow().apply(createData());
  d.graphView = {
    schemaVersion: 1,
    labelColumnId: d.columns[0].id,
    positions: { [d.rows[0].id]: { x: 1, y: 2 } },
  };
  const session = new DataSession(d);
  session.execute(removeColumn(d.columns[0].id));
  expect(session.content.graphView?.labelColumnId).toBe(d.columns[1].id);
  const before = session.content;
  expect(() =>
    session.execute(
      command<StructuredData>('bad', 'Bad', (current) => {
        current.rows[0].values.corrupt = Infinity;
        return current;
      }),
    ),
  ).toThrow('finite');
  expect(session.content).toEqual(before);
});
