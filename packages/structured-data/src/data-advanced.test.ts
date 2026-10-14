import { describe, it, expect } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import {
  createData,
  makeRow,
  cellValue,
  addColumn,
  removeColumn,
  setCell,
  type StructuredData,
} from './model';
import {
  defaultView,
  viewRows,
  pasteCells,
  setCells,
  previewColumn,
  updateColumn,
  summarize,
  tsv,
  parseTsv,
  moveDates,
  utcDay,
  deleteRows,
  saveView,
} from './views';
function fixture() {
  const data = createData();
  data.rows = Array.from({ length: 4 }, (_, i) => {
    const r = makeRow(data);
    r.values[data.columns[0].id] = ['Gamma', 'Alpha', 'Beta', 'Delta'][i];
    r.values[data.columns[2].id] = i + 1;
    return r;
  });
  return data;
}
describe('data operations and projections', () => {
  it('pastes by stable displayed IDs after sorting and as one undo transaction', () => {
    const d = fixture(),
      view = defaultView(d);
    view.sorts = [{ columnId: d.columns[0].id, descending: false }];
    const rows = viewRows(d, view),
      session = new EditorSession(d),
      cmd = pasteCells(
        d,
        rows.map((r) => r.id),
        d.columns.map((c) => c.id),
        0,
        2,
        '20\t4\n30\t5',
        false,
      );
    session.execute(cmd);
    expect(
      cellValue(
        session.content,
        session.content.rows.find((r) => r.id === rows[0].id)!,
        d.columns[4],
      ),
    ).toBe(80);
    expect(session.content.rows[0].values[d.columns[2].id]).toBe(1);
    session.undo();
    expect(session.content).toEqual(d);
    expect(cmd.apply(d)).toEqual(cmd.apply(d));
  });
  it('rejects a whole invalid/readonly paste and fixes added row IDs at generation', () => {
    const d = fixture(),
      ids = d.rows.map((r) => r.id),
      cols = d.columns.map((c) => c.id),
      session = new EditorSession(d);
    expect(() =>
      session.execute(pasteCells(d, ids, cols, 0, 2, '10\t20\nnot-number\t30', false)),
    ).toThrow('Enter a number');
    expect(session.content).toEqual(d);
    expect(session.canUndo).toBe(false);
    expect(() => session.execute(pasteCells(d, ids, cols, 0, 4, '42', false))).toThrow('read only');
    expect(() => pasteCells(d, ids, cols, 3, 0, 'First\nSecond', false)).toThrow(
      'Clear sort/filter',
    );
    const cmd = pasteCells(d, ids, cols, 3, 0, 'First\nSecond', true);
    expect(cmd.apply(d).rows.map((r) => r.id)).toEqual(cmd.apply(d).rows.map((r) => r.id));
    expect(cmd.apply(d).rows).toHaveLength(5);
  });
  it('preserves quoted TSV, explicit null and numeric summaries excluding null', () => {
    let d = fixture();
    d = setCell(d.rows[0].id, d.columns[0].id, '日本語\twith\n"quotes"').apply(d);
    const source = tsv(d, [d.rows[0].id], [d.columns[0].id]);
    expect(parseTsv(source)).toEqual([['日本語\twith\n"quotes"']]);
    d = setCell(d.rows[1].id, d.columns[2].id, null).apply(d);
    expect(summarize(d, d.rows, d.columns[2].id, 'average')).toBe(8 / 3);
    expect(summarize(d, [], d.columns[2].id, 'average')).toBeNull();
    expect(summarize(d, [], d.columns[2].id, 'count')).toBe(0);
  });
  it('previews failed type conversions without erasing values and keeps formulas across rename', () => {
    const d = fixture(),
      result = previewColumn(d, d.columns[0].id, { type: 'number' });
    expect(result.errors).toHaveLength(4);
    expect(() => updateColumn(d.columns[0].id, { type: 'number' }).apply(d)).toThrow(
      'cannot be converted',
    );
    expect(d.rows[0].values[d.columns[0].id]).toBe('Gamma');
    const renamed = updateColumn(d.columns[2].id, { name: '数量' }).apply(d);
    expect(cellValue(renamed, renamed.rows[0], renamed.columns[4])).toBe(10);
    expect(renamed.columns[4].formula).toContain(`[${d.columns[2].id}]`);
  });
  it('applies AND/OR filters, compound sorts and persists a named view without duplicating records', () => {
    const d = fixture(),
      view = defaultView(d);
    view.filters = [
      { id: 'one', columnId: d.columns[0].id, operator: 'contains', value: 'Alpha' },
      { id: 'two', columnId: d.columns[2].id, operator: 'greater', value: '3' },
    ];
    view.filterMode = 'or';
    view.sorts = [
      { columnId: d.columns[1].id, descending: false },
      { columnId: d.columns[2].id, descending: true },
    ];
    expect(viewRows(d, view).map((r) => r.values[d.columns[0].id])).toEqual(['Delta', 'Alpha']);
    view.filterMode = 'and';
    expect(viewRows(d, view)).toEqual([]);
    const saved = saveView(view).apply(d);
    expect(saved.rows).toBe(d.rows);
    expect(saved.views?.[0]).toEqual(view);
  });
  it('validates UTC dates, changes both endpoints atomically and rejects inverted ranges', () => {
    let d = fixture();
    for (const name of ['start', 'end']) d = addColumn({ id: name, name, type: 'date' }).apply(d);
    const timeline = { ...defaultView(d).timeline, start: 'start', end: 'end' },
      session = new EditorSession(d);
    session.execute(
      moveDates(d, d.rows[0].id, timeline, utcDay('2026-10-02')!, utcDay('2026-10-05')!),
    );
    expect(session.content.rows[0].values.start).toBe('2026-10-02');
    expect(session.content.rows[0].values.end).toBe('2026-10-05');
    session.undo();
    expect(session.content).toEqual(d);
    expect(() => moveDates(d, d.rows[0].id, timeline, 9, 8)).toThrow('End date');
    expect(utcDay('2026-02-30')).toBeNull();
  });
  it('protects dependent formulas during field changes and removes deleted fields from saved views', () => {
    const d = createData();
    d.rows = [makeRow(d)];
    const quantity = d.columns[2],
      status = d.columns[1];
    expect(() => removeColumn(quantity.id).apply(d)).toThrow('Total');
    expect(() => updateColumn(quantity.id, { type: 'text' }).apply(d)).toThrow('Total');
    const view = defaultView(d);
    view.groupBy = status.id;
    view.hidden = [status.id];
    view.filters = [{ id: 'filter', columnId: status.id, operator: 'equals', value: 'Planned' }];
    d.views = [view];
    const next = removeColumn(status.id).apply(d);
    expect(next.views![0].groupBy).toBe('');
    expect(next.views![0].filters).toEqual([]);
    expect(next.views![0].hidden).toEqual([]);
    expect(next.rows[0].values[status.id]).toBeUndefined();
    expect(cellValue(next, next.rows[0], next.columns.find((c) => c.name === 'Total')!)).toBe(10);
  });
  it('keeps relation references valid on row deletion and rejects deleted operation targets', () => {
    let d: StructuredData = fixture();
    d = addColumn({ id: 'relation', name: 'Related', type: 'relation' }).apply(d);
    d = setCell(d.rows[0].id, 'relation', d.rows[1].id).apply(d);
    const cmd = setCells([{ rowId: d.rows[1].id, columnId: d.columns[0].id, value: 'new' }]),
      deleted = deleteRows([d.rows[1].id]).apply(d);
    expect(deleted.rows[0].values.relation).toBeNull();
    expect(() => cmd.apply(deleted)).toThrow('deleted');
  });
});
