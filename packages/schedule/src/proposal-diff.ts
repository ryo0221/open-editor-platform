import {
  changedKeys,
  orderChanged,
  sameValue,
  textRange,
  type FallbackChange,
  type ProposalDiffAdapter,
  type SemanticChange,
} from '@editor-platform/editor-core';
import type { EventTime, ScheduleDocument, ScheduleEvent } from './model';
import { isKnownZone } from './zone';

/** The unit of an event period: its IANA zone, or `all-day` dates that never pass through UTC. */
function timeUnits(...times: EventTime[]) {
  const zones = [...new Set(times.map((t) => (t.kind === 'timed' ? t.timeZone : 'all-day')))];
  const unknown = zones.filter((z) => z !== 'all-day' && !isKnownZone(z));
  return unknown.length
    ? { unknownUnits: `Unknown time zone: ${unknown.join(', ')}` }
    : { units: zones.join(' → ') };
}

function eventChanges(old: ScheduleEvent, next: ScheduleEvent): SemanticChange[] {
  const base = { domain: 'schedule', elementId: next.id, elementLabel: next.title || old.title };
  const changes: SemanticChange[] = [];
  if (!sameValue(old.time, next.time))
    changes.push({
      ...base,
      kind: 'period',
      property: 'time',
      before: old.time,
      after: next.time,
      ...timeUnits(old.time, next.time),
    });
  for (const key of ['title', 'notes'] as const)
    if (old[key] !== next[key])
      changes.push({
        ...base,
        kind: 'text',
        property: key,
        before: old[key],
        after: next[key],
        units: 'utf16',
        range: textRange(old[key], next[key]),
      });
  for (const key of changedKeys(old, next, ['id', 'time', 'title', 'notes']))
    changes.push({
      ...base,
      kind: 'field',
      property: key,
      before: (old as unknown as Record<string, unknown>)[key],
      after: (next as unknown as Record<string, unknown>)[key],
    });
  return changes;
}

/** Event periods with their zone, titles, notes and record links keyed by event ID. */
export const scheduleProposalDiff: ProposalDiffAdapter<ScheduleDocument> = {
  domain: 'schedule',
  has: (d, id) => d.events.some((e) => e.id === id) || d.lanes.some((l) => l.id === id),
  diff(before, after) {
    const changes: SemanticChange[] = [],
      fallback: FallbackChange[] = [];
    const am = new Map(before.events.map((e) => [e.id, e]));
    for (const event of before.events)
      if (!after.events.some((e) => e.id === event.id))
        changes.push({
          domain: 'schedule',
          kind: 'removed',
          elementId: event.id,
          elementLabel: event.title,
          property: 'event',
          // The whole event: notes, conference and record links are approved with it.
          before: event,
          ...timeUnits(event.time),
        });
    for (const event of after.events) {
      const old = am.get(event.id);
      if (old) changes.push(...eventChanges(old, event));
      else
        changes.push({
          domain: 'schedule',
          kind: 'added',
          elementId: event.id,
          elementLabel: event.title,
          property: 'event',
          after: event,
          ...timeUnits(event.time),
        });
    }
    const ids = (d: ScheduleDocument) => d.events.map((e) => e.id);
    if (orderChanged(ids(before), ids(after)))
      changes.push({
        domain: 'schedule',
        kind: 'order',
        elementId: '',
        property: 'events',
        before: ids(before),
        after: ids(after),
      });
    if (before.timeZone !== after.timeZone)
      changes.push({
        domain: 'schedule',
        kind: 'property',
        elementId: '',
        property: 'timeZone',
        before: before.timeZone,
        after: after.timeZone,
        ...(isKnownZone(after.timeZone)
          ? {}
          : { unknownUnits: `Unknown time zone: ${after.timeZone}` }),
      });
    if (!sameValue(before.lanes, after.lanes))
      changes.push({
        domain: 'schedule',
        kind: 'property',
        elementId: '',
        property: 'lanes',
        before: before.lanes,
        after: after.lanes,
      });
    for (const key of changedKeys(before, after, ['events', 'timeZone', 'lanes']))
      fallback.push({
        path: key,
        before: (before as unknown as Record<string, unknown>)[key],
        after: (after as unknown as Record<string, unknown>)[key],
        reason: 'no-semantic-diff',
      });
    return { changes, view: [], fallback };
  },
};
