import { expect, it } from 'vitest';
import { deepFreeze } from '@editor-platform/artifact-core';
import { isStructuredData, validateData, type StructuredData } from './model';
import { defaultView } from './views';

function fixture(): StructuredData {
  return {
    schemaVersion: 2,
    columns: [
      { id: 'name', name: 'Name', type: 'text', required: true },
      { id: 'quantity', name: 'Quantity', type: 'number' },
      { id: 'total', name: 'Total', type: 'formula', formula: 'Quantity * 2' },
    ],
    rows: [{ id: 'record', values: { name: '案件', quantity: 3 } }],
  };
}

it.each([false, true])(
  'revalidates mutable or shallow-frozen row values and definitions (%s)',
  (shallow) => {
    const data = fixture();
    if (shallow) {
      Object.freeze(data);
      data.rows.forEach(Object.freeze);
      Object.freeze(data.columns);
    }
    expect(isStructuredData(data)).toBe(true);
    expect(validateData(data)).toEqual([]);
    data.rows[0].values.quantity = 'bad';
    expect(validateData(data)).toContainEqual({
      rowId: 'record',
      columnId: 'quantity',
      message: 'Enter a number',
    });
    data.rows[0].values.quantity = 3;
    data.columns[1].type = 'boolean';
    expect(validateData(data)).toContainEqual({
      rowId: 'record',
      columnId: 'quantity',
      message: 'Enter true or false',
    });
    (data.rows[0].values as Record<string, unknown>).quantity = { invalid: true };
    expect(isStructuredData(data)).toBe(false);
  },
);

it('revalidates reused immutable rows when columns, formulas or relation targets change', () => {
  const source = deepFreeze(fixture());
  expect(validateData(source)).toEqual([]);
  expect(isStructuredData(source)).toBe(true);
  const changed = deepFreeze({
    ...source,
    columns: source.columns.map((c) =>
      c.id === 'quantity' ? { ...c, type: 'boolean' as const } : c,
    ),
  });
  expect(validateData(changed).some((e) => e.columnId === 'quantity')).toBe(true);
  const formula = deepFreeze({
    ...source,
    columns: source.columns.map((c) => (c.id === 'total' ? { ...c, formula: 'Missing * 2' } : c)),
  });
  expect(validateData(formula).some((e) => e.columnId === 'total')).toBe(true);
  const related = deepFreeze({
    schemaVersion: 2 as const,
    columns: [{ id: 'relation', name: 'Relation', type: 'relation' as const }],
    rows: [
      { id: 'source', values: { relation: 'target' } },
      { id: 'target', values: { relation: null } },
    ],
  });
  expect(validateData(related)).toEqual([]);
  const missing = { ...related, rows: [related.rows[0]] };
  expect(validateData(missing)).toEqual([
    { rowId: 'source', columnId: 'relation', message: 'Choose an existing record' },
  ]);
  expect(isStructuredData({ ...source, rows: [...source.rows, source.rows[0]] })).toBe(false);
  expect(validateData(source)).toEqual([]);
});

it('rechecks new collections and mutable roots after validating shared immutable branches', () => {
  const source = deepFreeze(fixture());
  const view = deepFreeze(defaultView(source));
  const valid = deepFreeze({ ...source, views: [view] });
  expect(isStructuredData(valid)).toBe(true);
  expect(isStructuredData(valid)).toBe(true);
  const root = { ...valid };
  expect(isStructuredData(root)).toBe(true);
  root.rows = [...source.rows, source.rows[0]];
  expect(isStructuredData(root)).toBe(false);
  root.rows = source.rows;
  root.columns = [source.columns[0], { ...source.columns[1], name: 'Name' }];
  expect(isStructuredData(root)).toBe(false);
  root.columns = source.columns;
  root.views = [{ ...view, hidden: [42] } as unknown as typeof view];
  expect(isStructuredData(root)).toBe(false);
  expect(isStructuredData(deepFreeze({ ...valid, schemaVersion: 99 }))).toBe(false);
  expect(
    isStructuredData(
      deepFreeze({
        ...valid,
        rows: [{ ...source.rows[0], values: { quantity: { invalid: true } } }],
      }),
    ),
  ).toBe(false);
  expect(isStructuredData(valid)).toBe(true);
});
