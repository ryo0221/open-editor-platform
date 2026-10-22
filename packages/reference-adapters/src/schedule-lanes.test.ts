import { describe, expect, it } from 'vitest';
import type {
  EmbeddedReference,
  ReferenceResolver,
  ReferenceSnapshot,
} from '@editor-platform/artifact-references';
import { makeRow, type StructuredData } from '@editor-platform/structured-data/model';
import { defaultView } from '@editor-platform/structured-data/views';
import { laneItemLimit, laneShown } from '@editor-platform/schedule/host';
import {
  dataTimelineLanes,
  dataTimelineOptions,
  scheduleLaneHost,
  timelineView,
} from './schedule-lanes';

function plan(count = 3): StructuredData {
  const columns = [
    { id: 'col-name', name: 'Task', type: 'text' as const, required: true, defaultValue: 'Task' },
    { id: 'col-start', name: 'Start', type: 'date' as const },
    { id: 'col-end', name: 'End', type: 'date' as const },
    { id: 'col-note', name: 'Note', type: 'text' as const },
  ];
  const base: StructuredData = { schemaVersion: 2, columns, rows: [] };
  const rows = Array.from({ length: count }, (_, i) => ({
    ...makeRow(base, `row-${i}`),
    values: {
      'col-name': `Task ${i}`,
      'col-start': '2026-10-26',
      'col-end': i === 0 ? '2026-10-26' : '2026-10-28',
    },
  }));
  rows.push({
    ...makeRow(base, 'row-bad'),
    values: { 'col-name': 'Ends first', 'col-start': '2026-10-28', 'col-end': '2026-10-26' },
  });
  const view = {
    ...defaultView({ ...base, rows }),
    id: 'view-plan',
    name: 'Release plan',
    projection: 'Timeline' as const,
    timeline: {
      start: 'col-start',
      end: 'col-end',
      group: '',
      scale: 'week' as const,
      from: '',
      to: '',
    },
  };
  const textView = { ...view, id: 'view-text', timeline: { ...view.timeline, end: 'col-note' } };
  return { ...base, rows, views: [view, textView] };
}
const snapshot = (content: unknown): ReferenceSnapshot => ({
  artifactId: 'artifact_plan',
  domain: 'data',
  versionId: 'version_1',
  revision: 1,
  contentHash: 'hash',
  content,
  dependencies: [],
});

describe('Data timeline lanes for Schedule', () => {
  it('places saved-view records by row ID and skips records without a valid range', () => {
    const lanes = dataTimelineLanes(snapshot(plan()), { kind: 'timeline', viewId: 'view-plan' });
    expect(lanes.label).toBe('Release plan');
    expect(lanes.items.map((i) => i.rowId)).toEqual(['row-0', 'row-1', 'row-2']);
    expect(lanes.items[0]).toMatchObject({ label: 'Task 0', milestone: true });
    expect(lanes.hidden).toBe(0);
    const picked = dataTimelineLanes(snapshot(plan()), {
      kind: 'timeline',
      viewId: 'view-plan',
      rowIds: ['row-1'],
    });
    expect(picked.items.map((i) => i.rowId)).toEqual(['row-1']);
  });

  it('reports hidden records beyond the lane limit instead of dropping them silently', () => {
    const lanes = dataTimelineLanes(snapshot(plan(laneItemLimit + 5)), {
      kind: 'timeline',
      viewId: 'view-plan',
    });
    expect(lanes.items).toHaveLength(laneItemLimit);
    expect(lanes.hidden).toBe(5);
    // Their names stay available, so a link to one of them is not reported as missing.
    expect(Object.keys(lanes.hiddenLabels)).toHaveLength(5);
    expect(lanes.items.some((i) => i.rowId in lanes.hiddenLabels)).toBe(false);
  });

  it('refuses removed views, non-date fields, other targets and invalid content', () => {
    const data = plan();
    expect(timelineView(data, 'view-text')).toBeUndefined();
    expect(() =>
      dataTimelineLanes(snapshot(data), { kind: 'timeline', viewId: 'view-gone' }),
    ).toThrow(expect.objectContaining({ status: 'missing-target' }));
    expect(() =>
      dataTimelineLanes(snapshot(data), { kind: 'view', viewId: 'view-plan' } as never),
    ).toThrow(expect.objectContaining({ status: 'unsupported' }));
    expect(() =>
      dataTimelineLanes(snapshot({ nope: true }), { kind: 'timeline', viewId: 'view-plan' }),
    ).toThrow(expect.objectContaining({ status: 'error' }));
  });

  it('offers only timeline-capable views of Data artifacts', () => {
    const options = dataTimelineOptions([
      { id: 'a1', name: 'Plan', content: plan() },
      { id: 'a2', name: 'Not data', content: { events: [] } },
    ]);
    expect(options.map((o) => o.label)).toEqual([
      'Plan · Release plan · Timeline',
      'Plan · Default view · Timeline',
    ]);
    // A saved view using the reserved `default` ID is not offered beside the synthesized one.
    const reserved = plan();
    reserved.views = [{ ...reserved.views![0], id: 'default', name: 'Saved default' }];
    expect(
      dataTimelineOptions([{ id: 'a1', name: 'Plan', content: reserved }]).map((o) => o.label),
    ).toEqual(['Plan · Default view · Timeline']);
  });

  it('pins the version the lane shows instead of reading the newest one', async () => {
    const shown = { ...snapshot(plan()), versionId: 'version_2', revision: 2 };
    let reads = 0;
    const resolver = {
      get: () => ({ status: 'ready', snapshot: shown }),
      create: async () => {
        reads++;
        throw new Error('not expected');
      },
    } as unknown as ReferenceResolver;
    const following: EmbeddedReference = {
      schemaVersion: 1,
      source: {
        artifactId: 'artifact_plan',
        domain: 'data',
        target: { kind: 'timeline', viewId: 'view-plan' },
      },
      mode: 'follow',
      fit: 'contain',
      snapshot: snapshot(plan()),
    };
    const pinned = scheduleLaneHost(resolver, async () => []).pin(following);
    expect(pinned).toMatchObject({ mode: 'fixed', snapshot: { versionId: 'version_2' } });
    expect(reads).toBe(0);
    const unavailable = {
      get: () => ({ status: 'unavailable' }),
    } as unknown as ReferenceResolver;
    expect(() => scheduleLaneHost(unavailable, async () => []).pin(following)).toThrow(
      'Only a lane that is shown can be pinned.',
    );
  });

  it('keeps showing the verified retained version offline, and nothing for other failures', () => {
    const reference: EmbeddedReference = {
      schemaVersion: 1,
      source: {
        artifactId: 'artifact_plan',
        domain: 'data',
        target: { kind: 'timeline', viewId: 'view-plan' },
      },
      mode: 'follow',
      fit: 'contain',
      snapshot: snapshot(plan()),
    };
    const retained = snapshot(plan());
    const lanes = (state: object) =>
      scheduleLaneHost({ get: () => state } as unknown as ReferenceResolver, async () => []).state(
        reference,
      );
    const offline = lanes({ status: 'offline', message: 'No connection', snapshot: retained });
    expect(offline).toMatchObject({ status: 'offline', message: 'No connection', version: 'v1' });
    expect(offline.items.map((i) => i.rowId)).toEqual(['row-0', 'row-1', 'row-2']);
    expect(laneShown(offline)).toBe(true);
    // Without a verified snapshot, or for a refusal, nothing is shown.
    expect(laneShown(lanes({ status: 'offline', message: 'No connection' }))).toBe(false);
    const forbidden = lanes({ status: 'forbidden', snapshot: retained });
    expect(forbidden.items).toEqual([]);
    expect(laneShown(forbidden)).toBe(false);
  });
});
