/** Data saved views as Schedule lanes. The Schedule model never imports Data; the Host
 * composes the two through Artifact References. */
import {
  ReferenceError,
  type EmbeddedReference,
  type ReferenceOption,
  type ReferenceResolver,
  type ReferenceSnapshot,
  type ReferenceTarget,
} from '@editor-platform/artifact-references';
import {
  displayCell,
  isStructuredData,
  type StructuredData,
} from '@editor-platform/structured-data/model';
import { defaultView, viewRows, type DataView } from '@editor-platform/structured-data/views';
import { utcDay } from '@editor-platform/time-axis';
import {
  laneItemLimit,
  type ScheduleLaneHost,
  type ScheduleLaneItem,
  type ScheduleLaneState,
} from '@editor-platform/schedule/host';

/** The saved view a timeline target names, if its start and end are date fields. */
export function timelineView(data: StructuredData, viewId: string): DataView | undefined {
  const view = viewId === 'default' ? defaultView(data) : data.views?.find((v) => v.id === viewId);
  if (!view) return undefined;
  const date = (id: string) => data.columns.some((c) => c.id === id && c.type === 'date');
  return date(view.timeline.start) && date(view.timeline.end) ? view : undefined;
}

export function dataTimelineLanes(
  snapshot: ReferenceSnapshot,
  target: ReferenceTarget,
): {
  label: string;
  items: ScheduleLaneItem[];
  hidden: number;
  hiddenLabels: Record<string, string>;
} {
  const data = snapshot.content;
  if (!isStructuredData(data)) throw new ReferenceError('error', 'Dataの保存版が不正です。');
  if (target.kind !== 'timeline' || target.nodeIds || target.columnIds)
    throw new ReferenceError('unsupported', 'Dataのレーンは Timeline の参照だけに対応しています。');
  const view = timelineView(data, target.viewId);
  if (!view)
    throw new ReferenceError(
      'missing-target',
      '保存されたviewが削除されたか、開始・終了の日付の列がありません。',
    );
  const label = data.columns[0];
  const group = data.columns.find((c) => c.id === view.timeline.group);
  const items: ScheduleLaneItem[] = [];
  for (const row of viewRows(data, view)) {
    if (target.rowIds && !target.rowIds.includes(row.id)) continue;
    const startDate = String(row.values[view.timeline.start] ?? ''),
      endDate = String(row.values[view.timeline.end] ?? '');
    const s = utcDay(startDate),
      e = utcDay(endDate);
    if (s === null || e === null || e < s) continue;
    items.push({
      rowId: row.id,
      label: (label && displayCell(data, row, label)) || 'Record',
      startDate,
      endDate,
      ...(group ? { group: displayCell(data, row, group) } : {}),
      ...(s === e ? { milestone: true } : {}),
    });
  }
  return {
    label: view.name,
    items: items.slice(0, laneItemLimit),
    hidden: Math.max(0, items.length - laneItemLimit),
    // Names of records beyond the limit, so a link to one is never mistaken for a missing row.
    hiddenLabels: Object.fromEntries(
      items.slice(laneItemLimit).map((item) => [item.rowId, item.label]),
    ),
  };
}

/** Lanes backed by the Host's reference resolver: same access checks, fixed/follow and
 * offline rules as every other reference. */
export function scheduleLaneHost(
  resolver: ReferenceResolver,
  options: () => Promise<ReferenceOption[]>,
): ScheduleLaneHost {
  // Keyed by the shown snapshot, then by the captured one that supplies earlier names.
  const cache = new WeakMap<ReferenceSnapshot, WeakMap<ReferenceSnapshot, ScheduleLaneState>>();
  const previousLabels = (reference: EmbeddedReference, shown: ScheduleLaneItem[]) => {
    try {
      const ids = new Set(shown.map((item) => item.rowId));
      const before = dataTimelineLanes(reference.snapshot, reference.source.target);
      return Object.fromEntries(
        [
          ...before.items.map((item) => [item.rowId, item.label] as const),
          ...Object.entries(before.hiddenLabels),
        ].filter(([rowId]) => !ids.has(rowId)),
      );
    } catch {
      return {};
    }
  };
  return {
    async options() {
      return (await options()).filter(
        (o) => o.source.domain === 'data' && o.source.target.kind === 'timeline',
      );
    },
    create: (source, mode) => resolver.create(source, mode),
    pin(reference) {
      const state = resolver.get(reference);
      // A newer version that arrived after the lane was drawn is not the one the person saw.
      if (state.status !== 'ready' || !state.snapshot)
        throw new Error('Only a lane that is shown can be pinned.');
      return Object.freeze({ ...reference, mode: 'fixed' as const, snapshot: state.snapshot });
    },
    observe: (references, onChange) => resolver.observe(references, onChange),
    state(reference) {
      const state = resolver.get(reference);
      // Offline keeps the retained snapshot the resolver verified; every other failure hides it.
      if ((state.status !== 'ready' && state.status !== 'offline') || !state.snapshot)
        return { status: state.status, message: state.message, items: [], hidden: 0 };
      const byCaptured = cache.get(state.snapshot) ?? new WeakMap();
      cache.set(state.snapshot, byCaptured);
      const cached = byCaptured.get(reference.snapshot);
      if (cached) return cached;
      let result: ScheduleLaneState;
      try {
        const lanes = dataTimelineLanes(state.snapshot, reference.source.target);
        result = {
          status: state.status,
          ...(state.message ? { message: state.message } : {}),
          label: lanes.label,
          version: `v${state.snapshot.revision}`,
          items: lanes.items,
          hidden: lanes.hidden,
          ...(lanes.hidden ? { hiddenLabels: lanes.hiddenLabels } : {}),
          ...(reference.snapshot !== state.snapshot
            ? { previousLabels: previousLabels(reference, lanes.items) }
            : {}),
        };
      } catch (error) {
        result = {
          status: error instanceof ReferenceError ? error.status : 'error',
          message: (error as Error).message,
          items: [],
          hidden: 0,
        };
      }
      byCaptured.set(reference.snapshot, result);
      return result;
    },
  };
}

/** Timeline-capable saved views of saved Data artifacts, for the lane picker. */
export function dataTimelineOptions(
  artifacts: { id: string; name: string; content: unknown }[],
): ReferenceOption[] {
  return artifacts.flatMap((a) => {
    const data = a.content;
    if (!isStructuredData(data)) return [];
    // `default` is the reserved ID of the synthesized view (dataReferenceAdapter refuses a saved
    // view with it), so a saved one is never offered beside it.
    return [
      ...(data.views ?? []).filter((view) => view.id !== 'default'),
      { id: 'default', name: 'Default view' },
    ]
      .filter((view) => timelineView(data, view.id))
      .map((view) => ({
        label: `${a.name} · ${view.name} · Timeline`,
        source: { artifactId: a.id, domain: 'data', target: { kind: 'timeline', viewId: view.id } },
      }));
  });
}
