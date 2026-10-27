import {
  changedKeys,
  orderChanged,
  sameValue,
  type FallbackChange,
  type ProposalDiffAdapter,
  type SemanticChange,
} from '@editor-platform/editor-core';
import type { Column, DataRow, StructuredData } from './model';
import { defaultView } from './views';

const isoDay = /^\d{4}-\d{2}-\d{2}$/;
/** Date cells are ISO days; anything else has no known calendar unit. */
function dayUnits(column: Column, ...values: unknown[]) {
  const unknown = values.some(
    (v) => v !== null && v !== undefined && v !== '' && (typeof v !== 'string' || !isoDay.test(v)),
  );
  return unknown
    ? { unknownUnits: `${column.name} is not an ISO date` }
    : { units: 'iso-date' as const };
}
/** Start/end column pairs a Timeline reads as one period: saved views, else the default view. */
function periods(data: StructuredData) {
  const pairs = new Map<string, { start: string; end: string }>();
  for (const view of data.views?.length ? data.views : [defaultView(data)]) {
    const { start, end } = view.timeline;
    if (start && end && start !== end) pairs.set(`${start}..${end}`, { start, end });
  }
  return [...pairs.values()];
}
function rowLabel(data: StructuredData, row: DataRow) {
  const first = data.columns.find((c) => c.type === 'text');
  const value = first ? row.values[first.id] : undefined;
  return value === null || value === undefined || value === '' ? row.id : String(value);
}

function rowChanges(
  before: StructuredData,
  after: StructuredData,
  old: DataRow,
  next: DataRow,
): SemanticChange[] {
  const changes: SemanticChange[] = [];
  const columns = new Map([...before.columns, ...after.columns].map((c) => [c.id, c]));
  const base = { domain: 'data', elementId: old.id, elementLabel: rowLabel(after, next) };
  const covered = new Set<string>();
  for (const { start, end } of periods(after)) {
    const s = columns.get(start),
      e = columns.get(end);
    // A field converted from date keeps its saved Timeline setting; compare it as a field.
    if (s?.type !== 'date' || e?.type !== 'date') continue;
    const a = { start: old.values[start] ?? null, end: old.values[end] ?? null },
      b = { start: next.values[start] ?? null, end: next.values[end] ?? null };
    if (sameValue(a, b)) continue;
    covered.add(start).add(end);
    changes.push({
      ...base,
      kind: 'period',
      property: `${start}..${end}`,
      propertyLabel: `${s.name} – ${e.name}`,
      before: a,
      after: b,
      ...dayUnits(s, a.start, a.end, b.start, b.end),
    });
  }
  for (const id of changedKeys(old.values, next.values)) {
    if (covered.has(id)) continue;
    const column = columns.get(id);
    const x = old.values[id],
      y = next.values[id];
    changes.push({
      ...base,
      kind: 'field',
      property: id,
      propertyLabel: column?.name ?? id,
      before: x,
      after: y,
      ...(column?.type === 'date' ? dayUnits(column, x, y) : {}),
    });
  }
  return changes;
}

/**
 * Record changes keyed by row ID, the same in every projection. Saved views and the graph
 * layout are display settings and stay out of the content changes.
 */
export const dataProposalDiff: ProposalDiffAdapter<StructuredData> = {
  domain: 'data',
  has: (d, id) =>
    d.rows.some((r) => r.id === id) ||
    d.columns.some((c) => c.id === id) ||
    !!d.views?.some((v) => v.id === id),
  diff(before, after) {
    const changes: SemanticChange[] = [],
      view: SemanticChange[] = [],
      fallback: FallbackChange[] = [];
    const am = new Map(before.rows.map((r) => [r.id, r])),
      bm = new Map(after.rows.map((r) => [r.id, r]));
    for (const row of before.rows)
      if (!bm.has(row.id))
        changes.push({
          domain: 'data',
          kind: 'removed',
          elementId: row.id,
          elementLabel: rowLabel(before, row),
          property: 'record',
          before: row.values,
        });
    for (const row of after.rows) {
      const old = am.get(row.id);
      if (!old)
        changes.push({
          domain: 'data',
          kind: 'added',
          elementId: row.id,
          elementLabel: rowLabel(after, row),
          property: 'record',
          after: row.values,
        });
      else changes.push(...rowChanges(before, after, old, row));
    }
    const cm = new Map(before.columns.map((c) => [c.id, c]));
    for (const column of after.columns) {
      const old = cm.get(column.id);
      if (!old || !sameValue(old, column))
        changes.push({
          domain: 'data',
          kind: old ? 'property' : 'added',
          elementId: column.id,
          elementLabel: column.name,
          property: 'column',
          ...(old ? { before: old } : {}),
          after: column,
        });
    }
    for (const column of before.columns)
      if (!after.columns.some((c) => c.id === column.id))
        changes.push({
          domain: 'data',
          kind: 'removed',
          elementId: column.id,
          elementLabel: column.name,
          property: 'column',
          before: column,
        });
    const columnIds = (d: StructuredData) => d.columns.map((c) => c.id);
    if (orderChanged(columnIds(before), columnIds(after)))
      changes.push({
        domain: 'data',
        kind: 'order',
        elementId: '',
        property: 'columns',
        before: columnIds(before),
        after: columnIds(after),
      });
    const rowIds = (d: StructuredData) => d.rows.map((r) => r.id);
    if (orderChanged(rowIds(before), rowIds(after)))
      changes.push({
        domain: 'data',
        kind: 'order',
        elementId: '',
        property: 'rows',
        before: rowIds(before),
        after: rowIds(after),
      });
    const vm = new Map((before.views ?? []).map((v) => [v.id, v])),
      nextViews = after.views ?? [];
    for (const next of nextViews) {
      const old = vm.get(next.id);
      if (!old)
        view.push({
          domain: 'data',
          kind: 'added',
          elementId: next.id,
          elementLabel: next.name,
          property: 'view',
          after: next,
        });
      else
        for (const key of changedKeys(old, next))
          view.push({
            domain: 'data',
            kind: 'property',
            elementId: next.id,
            elementLabel: next.name,
            property: key,
            before: (old as unknown as Record<string, unknown>)[key],
            after: (next as unknown as Record<string, unknown>)[key],
          });
    }
    for (const old of before.views ?? [])
      if (!nextViews.some((v) => v.id === old.id))
        view.push({
          domain: 'data',
          kind: 'removed',
          elementId: old.id,
          elementLabel: old.name,
          property: 'view',
          before: old,
        });
    // The first saved view opens by default, so the saved-view order is a display setting too.
    const viewIds = (d: StructuredData) => (d.views ?? []).map((v) => v.id);
    if (orderChanged(viewIds(before), viewIds(after)))
      view.push({
        domain: 'data',
        kind: 'order',
        elementId: '',
        property: 'views',
        before: viewIds(before),
        after: viewIds(after),
      });
    if (!sameValue(before.graphView, after.graphView))
      view.push({
        domain: 'data',
        kind: 'property',
        elementId: '',
        property: 'graphView',
        before: before.graphView,
        after: after.graphView,
      });
    for (const key of changedKeys(before, after, ['rows', 'columns', 'views', 'graphView']))
      fallback.push({
        path: key,
        before: (before as unknown as Record<string, unknown>)[key],
        after: (after as unknown as Record<string, unknown>)[key],
        reason: 'no-semantic-diff',
      });
    return { changes, view, fallback };
  },
};
