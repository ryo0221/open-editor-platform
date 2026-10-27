import { describe, expect, it } from 'vitest';
import {
  EditorSession,
  command,
  reviewProposedCommands,
  transaction,
  withCommandReads,
  type EditorCommand,
} from '@editor-platform/editor-core';
import { setCell, type StructuredData } from './model';
import {
  defaultView,
  moveDates,
  reorderColumn,
  saveView,
  utcDay,
  type DataProjection,
} from './views';
import { dataProposalDiff } from './proposal-diff';

function data(): StructuredData {
  const base: StructuredData = {
    schemaVersion: 2,
    columns: [
      { id: 'name', name: 'Name', type: 'text' },
      { id: 'status', name: 'Status', type: 'select', options: ['Planned', 'Active', 'Done'] },
      { id: 'start', name: 'Start', type: 'date' },
      { id: 'end', name: 'End', type: 'date' },
    ],
    rows: [
      {
        id: 'row-a',
        values: { name: 'Design', status: 'Planned', start: '2026-10-05', end: '2026-10-09' },
      },
      {
        id: 'row-b',
        values: { name: 'Build', status: 'Planned', start: '2026-10-12', end: '2026-10-16' },
      },
    ],
  };
  const view = (id: string, projection: DataProjection) => ({
    ...defaultView(base),
    id,
    name: projection,
    projection,
    groupBy: projection === 'Kanban' ? 'status' : '',
  });
  return {
    ...base,
    views: [view('grid', 'Grid'), view('kanban', 'Kanban'), view('timeline', 'Timeline')],
  };
}
const proposalCommands = (d: StructuredData): EditorCommand<StructuredData>[] => [
  withCommandReads(setCell('row-a', 'status', 'Active'), { content: ['row-a'] }),
  withCommandReads(
    moveDates(d, 'row-a', d.views!.at(-1)!.timeline, utcDay('2026-10-06')!, utcDay('2026-10-12')!),
    { content: ['row-a'] },
  ),
];
const review = (content: StructuredData, commands = proposalCommands(content)) =>
  reviewProposedCommands(
    { content, base: { artifactId: 'data-1', versionId: 'v1' } },
    { id: 'p', summary: 'Start Design next week', commands },
    dataProposalDiff,
  );

describe('Structured Data proposal diff', () => {
  it('describes status and period by record ID and matches the native command result', () => {
    const content = data();
    const result = review(content);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.changes).toEqual([
      {
        domain: 'data',
        kind: 'period',
        elementId: 'row-a',
        elementLabel: 'Design',
        property: 'start..end',
        propertyLabel: 'Start – End',
        before: { start: '2026-10-05', end: '2026-10-09' },
        after: { start: '2026-10-06', end: '2026-10-12' },
        units: 'iso-date',
      },
      {
        domain: 'data',
        kind: 'field',
        elementId: 'row-a',
        elementLabel: 'Design',
        property: 'status',
        propertyLabel: 'Status',
        before: 'Planned',
        after: 'Active',
      },
    ]);
    expect(result.view).toEqual([]);
    const session = new EditorSession(content);
    session.execute(transaction('Proposal', proposalCommands(content)));
    expect(session.content).toEqual(result.preview.content);
    expect(dataProposalDiff.diff(content, session.content).changes).toEqual(result.changes);
    expect(content).toEqual(data());
  });
  it('gives the same record change whichever projection the reviewer is on', () => {
    const content = data();
    const results = content.views!.map((view) => {
      // Only one saved view, shown in Grid, Kanban or Timeline.
      const r = review({ ...content, views: [view] });
      return r.status === 'ready' ? [view.projection, r.changes] : [view.projection, r.status];
    });
    expect(new Set(results.map(([, changes]) => JSON.stringify(changes))).size).toBe(1);
  });
  it('keeps saved display settings out of the content changes', () => {
    const content = data();
    const regroup = saveView({ ...content.views![1], groupBy: 'end' });
    const result = review(content, [regroup]);
    expect(result).toMatchObject({
      status: 'ready',
      changes: [],
      view: [
        { kind: 'property', elementId: 'kanban', property: 'groupBy', after: 'end' },
        { kind: 'order', property: 'views', after: ['grid', 'timeline', 'kanban'] },
      ],
    });
    const both = review(content, [...proposalCommands(content), regroup]);
    expect(both.status === 'ready' && both.changes.map((c) => c.kind)).toEqual(['period', 'field']);
  });
  it('reports a saved-view reorder as a display setting', () => {
    const content = data();
    // saveView moves an existing view to the end, which changes the view that opens first.
    const result = review(content, [saveView(content.views![0])]);
    expect(result).toMatchObject({
      status: 'ready',
      changes: [],
      view: [{ kind: 'order', property: 'views', after: ['kanban', 'timeline', 'grid'] }],
    });
  });
  it('reports a column reorder instead of no change', () => {
    const result = review(data(), [reorderColumn('end', 'start')]);
    expect(result).toMatchObject({
      status: 'ready',
      changes: [{ kind: 'order', property: 'columns', after: ['name', 'status', 'end', 'start'] }],
    });
  });
  it('compares a field converted from date as a field, not a period', () => {
    const content = data();
    content.columns = content.columns.map((c) => (c.id === 'end' ? { ...c, type: 'text' } : c));
    const result = review(content, [setCell('row-a', 'end', 'TBD')]);
    expect(result).toMatchObject({
      status: 'ready',
      changes: [{ kind: 'field', property: 'end', before: '2026-10-09', after: 'TBD' }],
    });
  });
  it('refuses deleted records and values without a calendar unit', () => {
    const content = data();
    const gone = review({ ...content, rows: content.rows.filter((r) => r.id !== 'row-a') });
    expect(gone).toMatchObject({
      status: 'refused',
      reason: 'missing-target',
      elementIds: ['row-a'],
    });
    const vague = review(content, [
      command<StructuredData>('data.update-cell', 'Edit cell', (d) => ({
        ...d,
        rows: d.rows.map((r) =>
          r.id === 'row-b' ? { ...r, values: { ...r.values, end: 'next Friday' } } : r,
        ),
      })),
    ]);
    expect(vague).toMatchObject({
      status: 'refused',
      reason: 'unknown-units',
      elementIds: ['row-b'],
    });
  });
});
