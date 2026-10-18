import { describe, expect, it } from 'vitest';
import {
  addColumn,
  addRow,
  aggregate,
  cellValue,
  createData,
  dataDiff,
  exportCsv,
  groupRows,
  importCsv,
  makeRow,
  parseCsv,
  projectRows,
  setCell,
  validateData,
  type StructuredData,
} from './model';
function populated(): StructuredData {
  let d = createData();
  d = addRow().apply(d);
  d = addRow().apply(d);
  d = setCell(d.rows[0].id, d.columns[0].id, 'Alpha').apply(d);
  d = setCell(d.rows[1].id, d.columns[0].id, 'Beta').apply(d);
  return d;
}
describe('structured data', () => {
  it('creates stable rows with defaults and recomputes formulas', () => {
    let d = populated();
    expect(d.rows[0].id).not.toBe(d.rows[1].id);
    expect(cellValue(d, d.rows[0], d.columns[4])).toBe(10);
    d = setCell(d.rows[0].id, d.columns[2].id, 4).apply(d);
    expect(cellValue(d, d.rows[0], d.columns[4])).toBe(40);
    expect(validateData(d)).toEqual([]);
  });
  it('validates required, numeric, boolean, date, select and relation fields', () => {
    let d = populated();
    for (const [type, value] of [
      ['boolean', 'wrong'],
      ['date', '2025-02-31'],
      ['relation', 'missing'],
    ] as const)
      d = addColumn({ id: type, name: type, type, defaultValue: value }).apply(d);
    d = setCell(d.rows[0].id, d.columns[0].id, '').apply(d);
    d = setCell(d.rows[0].id, d.columns[2].id, 'oops').apply(d);
    d = setCell(d.rows[0].id, d.columns[1].id, 'unknown').apply(d);
    expect(validateData(d).map((e) => e.message)).toEqual(
      expect.arrayContaining([
        'Required field',
        'Enter a number',
        'Enter true or false',
        'Enter a valid date (YYYY-MM-DD)',
        'Choose a listed option',
        'Choose an existing record',
      ]),
    );
  });
  it('evaluates precedence and brackets without eval', () => {
    let d = populated();
    d = addColumn({ id: 'x', name: 'Tax rate', type: 'number', defaultValue: 2 }).apply(d);
    d = addColumn({
      id: 'f',
      name: 'Computed',
      type: 'formula',
      formula: '(Quantity + [Tax rate]) * Price / 2',
    }).apply(d);
    expect(cellValue(d, d.rows[0], d.columns.at(-1)!)).toBe(15);
  });
  it('rejects code, division by zero, missing fields and circular formulas', () => {
    const d = populated();
    for (const formula of ['globalThis.alert(1)', '1 / 0', 'Missing + 1', 'Total + 1']) {
      const changed = {
        ...d,
        columns: d.columns.map((c) => (c.name === 'Total' ? { ...c, formula } : c)),
      };
      expect(validateData(changed).length).toBeGreaterThan(0);
    }
  });
  it('filters, sorts, groups and aggregates one shared dataset', () => {
    let d = populated();
    d = setCell(d.rows[1].id, d.columns[2].id, 3).apply(d);
    d = setCell(d.rows[1].id, d.columns[1].id, 'Done').apply(d);
    expect(projectRows(d, { filter: 'alpha' })).toHaveLength(1);
    expect(
      projectRows(d, { sort: d.columns[2].id, descending: true })[0].values[d.columns[0].id],
    ).toBe('Beta');
    expect([...groupRows(d, d.rows, d.columns[1].id).keys()]).toEqual(['Planned', 'Done']);
    expect(aggregate(d, d.rows, d.columns[4].id)).toEqual({ count: 2, sum: 40, average: 20 });
  });
  it('round trips CSV commas, quotes, multiline text, numbers and booleans', () => {
    const d = importCsv(
      'Name,Amount,Enabled\r\n"A, B",4,true\r\n"line\nwith ""quotes""",2,false\r\n',
    );
    expect(d.columns.map((c) => c.type)).toEqual(['text', 'number', 'boolean']);
    expect(parseCsv(exportCsv(d))).toEqual([
      ['Name', 'Amount', 'Enabled'],
      ['A, B', '4', 'true'],
      ['line\nwith "quotes"', '2', 'false'],
    ]);
    expect(() => parseCsv('"broken')).toThrow();
  });
  it('reports schema, row and cell changes independently', () => {
    const a = populated();
    let b = setCell(a.rows[0].id, a.columns[0].id, 'Updated').apply(a);
    b = addColumn({ id: 'extra', name: 'Extra', type: 'text' }).apply(b);
    b = { ...b, rows: [...b.rows, makeRow(b)] };
    const changes = dataDiff(a, b).changes;
    expect(changes.some((c) => c.path === 'Updated / Name' && c.kind === 'changed')).toBe(true);
    expect(changes.some((c) => c.path === 'Field: Extra' && c.kind === 'added')).toBe(true);
    expect(changes.some((c) => c.path === 'row' && c.kind === 'added')).toBe(true);
    expect(changes.find((c) => c.kind === 'added' && c.path === 'row')?.after).toContain('Name:');
  });
  it('rejects duplicate schema field names', () => {
    const d = createData();
    expect(() => addColumn({ id: 'x', name: 'Name', type: 'text' }).apply(d)).toThrow();
  });
});

it('keeps leading-zero CSV keys as text for cross-artifact joins', () => {
  const data = importCsv('branch,sales\n01,100\n02,400');
  expect(data.columns.map((c) => c.type)).toEqual(['text', 'number']);
  expect(data.rows[0].values[data.columns[0].id]).toBe('01');
});
