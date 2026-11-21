import { describe, expect, it } from 'vitest';
import type { StructuredData } from './model';
import { gridEntries } from './grid-model';
import { defaultView, viewRows } from './views';

// #23: grouped grid entries must match the grouped row order, so each group shows once.
describe('grouped grid entries', () => {
  const data: StructuredData = {
    schemaVersion: 2,
    columns: [
      { id: 'title', name: 'Title', type: 'text' },
      { id: 'status', name: 'Status', type: 'text' },
    ],
    rows: [
      { id: 'a', values: { title: 'A', status: '' } },
      { id: 'b', values: { title: 'B', status: 'Open' } },
      { id: 'c', values: { title: 'C' } },
      { id: 'd', values: { title: 'D', status: 'Open' } },
      { id: 'e', values: { title: 'E', status: '' } },
    ],
  };
  it('an empty text and a missing value form one "(empty)" group, and every group header appears once with its count', () => {
    const view = { ...defaultView(data), groupBy: 'status' };
    const rows = viewRows(data, view);
    expect(rows.map((r) => r.id)).toEqual(['a', 'c', 'e', 'b', 'd']);
    const entries = gridEntries(data, rows, view);
    const headers = entries.flatMap((e) => ('group' in e ? [[e.group, e.count]] : []));
    expect(headers).toEqual([
      ['(empty)', 3],
      ['Open', 2],
    ]);
    // Row entries keep the row's position in the row list (used to choose and scroll to it)
    expect(entries.flatMap((e) => ('row' in e ? [[e.row.id, e.index]] : []))).toEqual([
      ['a', 0],
      ['c', 1],
      ['e', 2],
      ['b', 3],
      ['d', 4],
    ]);
  });
});
