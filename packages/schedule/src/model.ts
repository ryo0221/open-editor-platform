/** Schedule native model: user-authored event drafts. No network, credentials or Host records. */
import { canonicalJson, newId } from '@editor-platform/artifact-core';
import { immutableCommand, type EditorCommand } from '@editor-platform/editor-core';
import {
  validEmbeddedReference,
  type EmbeddedReference,
} from '@editor-platform/artifact-references';
import { addDays, utcDay } from '@editor-platform/time-axis';
import {
  canonicalZone,
  formatLocal,
  isKnownZone,
  localMillis,
  resolveLocal,
  type Fold,
  type LocalDateTime,
} from './zone';

export const SCHEDULE_SCHEMA = 1;
export const scheduleLimits = {
  events: 2000,
  bytes: 2 * 1024 * 1024,
  titleScalars: 512,
  notesBytes: 16 * 1024,
  lanes: 8,
  linksPerEvent: 20,
  idLength: 128,
} as const;
export const conferences = ['none', 'meet', 'teams', 'zoom'] as const;
export type ConferencePreference = (typeof conferences)[number];

export interface TimedTime {
  kind: 'timed';
  startLocal: LocalDateTime;
  endLocal: LocalDateTime;
  /** Canonical IANA zone of both wall times. */
  timeZone: string;
  /** Required only when the wall time occurs twice in the zone. */
  startFold?: Fold;
  endFold?: Fold;
}
export interface AllDayTime {
  kind: 'allDay';
  startDate: string;
  /** The day after the last day, as in calendar providers. Never converted through UTC. */
  endDateExclusive: string;
}
export type EventTime = TimedTime | AllDayTime;
/** A link to a Data record shown in one of this Schedule's lanes. */
export interface RecordLink {
  laneId: string;
  rowId: string;
}
export interface ScheduleEvent {
  id: string;
  title: string;
  /** Plain text. */
  notes: string;
  time: EventTime;
  conference: ConferencePreference;
  links: RecordLink[];
}
/** A Data saved view read through Artifact References, as a band of work items. */
export interface ScheduleLane {
  id: string;
  reference: EmbeddedReference;
}
export interface ScheduleDocument {
  schemaVersion: typeof SCHEDULE_SCHEMA;
  /** Zone for new timed events. Display zone is private view state. */
  timeZone: string;
  events: ScheduleEvent[];
  lanes: ScheduleLane[];
}

export class ScheduleError extends Error {
  constructor(
    public readonly code:
      | 'invalid'
      | 'missing-time'
      | 'ambiguous-time'
      | 'order'
      | 'zone'
      | 'limit'
      | 'not-found',
    message: string,
    /** The wall time a time error is about, when it is about one of them. */
    public readonly field?: 'start' | 'end',
  ) {
    super(message);
  }
}

export function createSchedule(timeZone = 'UTC'): ScheduleDocument {
  const name = canonicalZone(timeZone);
  if (!name) throw new ScheduleError('zone', `Unknown time zone ${timeZone}`);
  return { schemaVersion: SCHEDULE_SCHEMA, timeZone: name, events: [], lanes: [] };
}

const plain = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const exactKeys = (v: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((k) => Object.hasOwn(v, k)) &&
  Object.keys(v).every((k) => required.includes(k) || optional.includes(k));
const validId = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= scheduleLimits.idLength &&
  !['__proto__', 'prototype', 'constructor'].includes(v);
const scalars = (s: string) => [...s].length;
const utf8 = (s: string) => new TextEncoder().encode(s).length;
// Control characters other than tab and newline never enter plain text fields.
// eslint-disable-next-line no-control-regex
const unsafeText = (s: string) => /[\u0000-\u0008\u000b-\u001f\u007f]/.test(s);

/** Resolved instants of a timed event; throws the reason when the wall times cannot be used. */
export function timedInstants(time: TimedTime): { start: number; end: number } {
  if (!isKnownZone(time.timeZone))
    throw new ScheduleError('zone', `Unknown time zone ${time.timeZone}`);
  const pick = (local: LocalDateTime, fold: Fold | undefined, which: 'start' | 'end') => {
    const r = resolveLocal(local, time.timeZone);
    if (r.kind === 'missing')
      throw new ScheduleError(
        'missing-time',
        `The ${which} time ${local.replace('T', ' ')} does not exist in ${time.timeZone}`,
        which,
      );
    if (r.kind === 'ambiguous') {
      if (!fold)
        throw new ScheduleError(
          'ambiguous-time',
          `The ${which} time ${local.replace('T', ' ')} occurs twice in ${time.timeZone}. Choose the earlier or later one`,
          which,
        );
      return fold === 'earlier' ? r.earlier : r.later;
    }
    if (fold) throw new ScheduleError('invalid', `The ${which} time occurs only once`, which);
    return r.instant;
  };
  const start = pick(time.startLocal, time.startFold, 'start'),
    end = pick(time.endLocal, time.endFold, 'end');
  if (end <= start) throw new ScheduleError('order', 'The end must be after the start');
  return { start, end };
}
export function assertEventTime(time: unknown): asserts time is EventTime {
  if (!plain(time)) throw new ScheduleError('invalid', 'Invalid event time');
  if (time.kind === 'allDay') {
    if (!exactKeys(time, ['kind', 'startDate', 'endDateExclusive']))
      throw new ScheduleError('invalid', 'Invalid all-day time');
    const s = utcDay(String(time.startDate)),
      e = utcDay(String(time.endDateExclusive));
    if (s === null || e === null) throw new ScheduleError('invalid', 'Invalid all-day date');
    if (e <= s) throw new ScheduleError('order', 'The end must be after the start');
    return;
  }
  if (
    time.kind !== 'timed' ||
    !exactKeys(time, ['kind', 'startLocal', 'endLocal', 'timeZone'], ['startFold', 'endFold']) ||
    typeof time.startLocal !== 'string' ||
    typeof time.endLocal !== 'string' ||
    typeof time.timeZone !== 'string' ||
    localMillis(time.startLocal) === null ||
    localMillis(time.endLocal) === null ||
    [time.startFold, time.endFold].some((f) => f !== undefined && f !== 'earlier' && f !== 'later')
  )
    throw new ScheduleError('invalid', 'Invalid timed event');
  timedInstants(time as unknown as TimedTime);
}
function assertEvent(value: unknown, laneIds: Set<string>): asserts value is ScheduleEvent {
  if (
    !plain(value) ||
    !exactKeys(value, ['id', 'title', 'notes', 'time', 'conference', 'links']) ||
    !validId(value.id) ||
    typeof value.title !== 'string' ||
    typeof value.notes !== 'string' ||
    !conferences.includes(value.conference as ConferencePreference) ||
    !Array.isArray(value.links)
  )
    throw new ScheduleError('invalid', 'Invalid event');
  if (scalars(value.title) > scheduleLimits.titleScalars || unsafeText(value.title))
    throw new ScheduleError('limit', 'The title is too long or contains control characters');
  if (utf8(value.notes) > scheduleLimits.notesBytes || unsafeText(value.notes))
    throw new ScheduleError('limit', 'The notes are too long or contain control characters');
  if (value.links.length > scheduleLimits.linksPerEvent)
    throw new ScheduleError('limit', 'Too many related records');
  const keys = new Set<string>();
  for (const link of value.links) {
    if (
      !plain(link) ||
      !exactKeys(link, ['laneId', 'rowId']) ||
      !validId(link.laneId) ||
      !validId(link.rowId) ||
      !laneIds.has(link.laneId)
    )
      throw new ScheduleError('invalid', 'Invalid related record');
    const key = canonicalJson([link.laneId, link.rowId]);
    if (keys.has(key)) throw new ScheduleError('invalid', 'Duplicate related record');
    keys.add(key);
  }
  assertEventTime(value.time);
}

// Per-event validation results. Only frozen events are remembered: they cannot change after the
// check. EditorSession freezes its content and a command reuses the events it does not change, so
// an edit re-checks only the changed event. Anything else is checked in full every time.
/** Frozen event → the lane IDs it was checked against (its links must name existing lanes). */
const checkedEvents = new WeakMap<object, string>();
/** Deeply frozen as far as validation reads it, so a remembered result cannot go stale. */
export const frozenEvent = (event: unknown): event is ScheduleEvent =>
  typeof event === 'object' &&
  event !== null &&
  Object.isFrozen(event) &&
  Object.isFrozen((event as ScheduleEvent).time) &&
  Object.isFrozen((event as ScheduleEvent).links) &&
  (Array.isArray((event as ScheduleEvent).links)
    ? (event as ScheduleEvent).links.every((link) => Object.isFrozen(link))
    : true);

/** Domain validator for drafts, retained versions and imports. Rejects the whole value. */
export function assertSchedule(value: unknown): asserts value is ScheduleDocument {
  if (
    !plain(value) ||
    !exactKeys(value, ['schemaVersion', 'timeZone', 'events', 'lanes']) ||
    value.schemaVersion !== SCHEDULE_SCHEMA ||
    typeof value.timeZone !== 'string' ||
    !Array.isArray(value.events) ||
    !Array.isArray(value.lanes)
  )
    throw new ScheduleError('invalid', 'Unsupported Schedule content');
  if (!isKnownZone(value.timeZone))
    throw new ScheduleError('zone', `Unknown time zone ${value.timeZone}`);
  if (value.events.length > scheduleLimits.events || value.lanes.length > scheduleLimits.lanes)
    throw new ScheduleError('limit', 'Too many events or lanes');
  const laneIds = new Set<string>();
  for (const lane of value.lanes) {
    if (
      !plain(lane) ||
      !exactKeys(lane, ['id', 'reference']) ||
      !validId(lane.id) ||
      !validEmbeddedReference(lane.reference) ||
      lane.reference.source.domain !== 'data' ||
      lane.reference.source.target.kind !== 'timeline'
    )
      throw new ScheduleError('invalid', 'Invalid lane');
    if (laneIds.has(lane.id)) throw new ScheduleError('invalid', 'Duplicate lane ID');
    laneIds.add(lane.id);
  }
  const ids = new Set<string>();
  const lanesKey = [...laneIds].join('\n');
  for (const event of value.events) {
    const frozen = frozenEvent(event);
    if (!frozen || checkedEvents.get(event) !== lanesKey) {
      assertEvent(event, laneIds);
      if (frozen) checkedEvents.set(event, lanesKey);
    }
    if (ids.has((event as ScheduleEvent).id))
      throw new ScheduleError('invalid', 'Duplicate event ID');
    ids.add((event as ScheduleEvent).id);
  }
  if (utf8(canonicalJson(value)) > scheduleLimits.bytes)
    throw new ScheduleError('limit', 'The Schedule is larger than 2 MiB');
}
/** Cheap kind check for routing a value to the Schedule editor; it does not validate. */
export function looksLikeSchedule(value: unknown): boolean {
  return (
    plain(value) &&
    value.schemaVersion === SCHEDULE_SCHEMA &&
    typeof value.timeZone === 'string' &&
    Array.isArray(value.events) &&
    Array.isArray(value.lanes)
  );
}
export function isSchedule(value: unknown): value is ScheduleDocument {
  try {
    assertSchedule(value);
    return true;
  } catch {
    return false;
  }
}

/** Calendar days covered by an event in the given display zone (inclusive). */
export function eventDays(
  time: EventTime,
  displayZone: string,
  wallDate: (instant: number, zone: string) => string,
) {
  if (time.kind === 'allDay')
    return { start: utcDay(time.startDate)!, end: utcDay(time.endDateExclusive)! - 1 };
  const { start, end } = timedInstants(time);
  return {
    start: utcDay(wallDate(start, displayZone))!,
    // An event ending exactly at midnight does not occupy the next day.
    end: utcDay(wallDate(end - 1, displayZone))!,
  };
}

/** Sort key: start instant (all-day events at the UTC start of their first day). */
export function eventStart(event: ScheduleEvent): number {
  return event.time.kind === 'allDay'
    ? utcDay(event.time.startDate)! * 86_400_000
    : timedInstants(event.time).start;
}

function find(content: ScheduleDocument, id: string) {
  const index = content.events.findIndex((e) => e.id === id);
  if (index < 0) throw new ScheduleError('not-found', 'The event no longer exists');
  return index;
}
function replaceEvent(
  content: ScheduleDocument,
  id: string,
  update: (event: ScheduleEvent) => ScheduleEvent,
): ScheduleDocument {
  const index = find(content, id);
  const events = content.events.slice();
  events[index] = update(content.events[index]);
  return checked({ ...content, events });
}
/** Every written time records IANA's current zone name; older names are read but not written.
 * Edits that leave the time alone keep it as stored, so they never reset a time being typed. */
function currentZone(time: EventTime): EventTime {
  if (time.kind !== 'timed') return time;
  const name = canonicalZone(time.timeZone);
  return name && name !== time.timeZone ? { ...time, timeZone: name } : time;
}
function checked(next: ScheduleDocument) {
  const name = canonicalZone(next.timeZone);
  if (name && name !== next.timeZone) next = { ...next, timeZone: name };
  assertSchedule(next);
  return next;
}

export interface NewEvent {
  id?: string;
  title?: string;
  notes?: string;
  time: EventTime;
  conference?: ConferencePreference;
}
export function createEvent(input: NewEvent): EditorCommand<ScheduleDocument> {
  const id = input.id ?? newId('event');
  return immutableCommand('schedule.createEvent', 'Create event', (content) => {
    if (content.events.some((e) => e.id === id))
      throw new ScheduleError('invalid', 'The event ID already exists');
    return checked({
      ...content,
      events: [
        ...content.events,
        {
          id,
          title: input.title ?? 'New event',
          notes: input.notes ?? '',
          time: currentZone(input.time),
          conference: input.conference ?? 'none',
          links: [],
        },
      ],
    });
  });
}
export function duplicateEvent(id: string, newEventId = newId('event')) {
  return immutableCommand<ScheduleDocument>('schedule.duplicateEvent', 'Duplicate event', (c) => {
    const source = c.events[find(c, id)];
    if (c.events.some((e) => e.id === newEventId))
      throw new ScheduleError('invalid', 'The event ID already exists');
    return checked({
      ...c,
      events: [...c.events, { ...source, id: newEventId, time: currentZone(source.time) }],
    });
  });
}
export const setEventTime = (id: string, time: EventTime) =>
  immutableCommand<ScheduleDocument>('schedule.setEventTime', 'Change event time', (c) =>
    replaceEvent(c, id, (e) => ({ ...e, time: currentZone(time) })),
  );
export const updateEventText = (
  id: string,
  patch: Partial<Pick<ScheduleEvent, 'title' | 'notes'>>,
) =>
  immutableCommand<ScheduleDocument>(
    'schedule.updateEventText',
    patch.title !== undefined ? 'Rename event' : 'Edit notes',
    (c) => replaceEvent(c, id, (e) => ({ ...e, ...patch })),
  );
export const setConference = (id: string, conference: ConferencePreference) =>
  immutableCommand<ScheduleDocument>('schedule.setConference', 'Change conference', (c) =>
    replaceEvent(c, id, (e) => ({ ...e, conference })),
  );
export const setRecordLinks = (id: string, links: RecordLink[]) =>
  immutableCommand<ScheduleDocument>('schedule.setRecordLinks', 'Change related records', (c) =>
    replaceEvent(c, id, (e) => ({ ...e, links })),
  );
export const removeEvent = (id: string) =>
  immutableCommand<ScheduleDocument>('schedule.removeEvent', 'Delete event', (c) => {
    find(c, id);
    return checked({ ...c, events: c.events.filter((e) => e.id !== id) });
  });
export const setDefaultZone = (timeZone: string) =>
  immutableCommand<ScheduleDocument>('schedule.setTimeZone', 'Change default time zone', (c) =>
    checked({ ...c, timeZone }),
  );

/** Move by whole days (all-day and timed) or minutes (timed, in wall-clock time). */
export function shiftTime(time: EventTime, days: number, minutes = 0): EventTime {
  if (time.kind === 'allDay') {
    const s = utcDay(time.startDate)! + days,
      e = utcDay(time.endDateExclusive)! + days;
    const day = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);
    return { kind: 'allDay', startDate: day(s), endDateExclusive: day(e) };
  }
  const delta = days * 86_400_000 + minutes * 60_000;
  const { startFold: _s, endFold: _e, ...rest } = time;
  return {
    ...rest,
    startLocal: formatLocal(localMillis(time.startLocal)! + delta),
    endLocal: formatLocal(localMillis(time.endLocal)! + delta),
  };
}

export const addLane = (lane: ScheduleLane) =>
  immutableCommand<ScheduleDocument>('schedule.addLane', 'Add lane', (c) => {
    if (c.lanes.some((l) => l.id === lane.id))
      throw new ScheduleError('invalid', 'The lane ID already exists');
    return checked({ ...c, lanes: [...c.lanes, lane] });
  });
/** Updating a lane keeps record links; links to removed records show as missing. */
export const setLaneReference = (laneId: string, reference: EmbeddedReference) =>
  immutableCommand<ScheduleDocument>(
    'schedule.setLaneReference',
    reference.mode === 'follow' ? 'Follow lane source' : 'Pin lane version',
    (c) => {
      if (!c.lanes.some((l) => l.id === laneId))
        throw new ScheduleError('not-found', 'The lane no longer exists');
      return checked({
        ...c,
        lanes: c.lanes.map((l) => (l.id === laneId ? { ...l, reference } : l)),
      });
    },
  );
/** Removing a lane removes its record links in the same transaction. */
export const removeLane = (laneId: string) =>
  immutableCommand<ScheduleDocument>('schedule.removeLane', 'Remove lane', (c) => {
    if (!c.lanes.some((l) => l.id === laneId))
      throw new ScheduleError('not-found', 'The lane no longer exists');
    return checked({
      ...c,
      lanes: c.lanes.filter((l) => l.id !== laneId),
      events: c.events.map((e) =>
        e.links.some((l) => l.laneId === laneId)
          ? { ...e, links: e.links.filter((l) => l.laneId !== laneId) }
          : e,
      ),
    });
  });

/** All day on and off. Turning it off keeps every occupied day instead of collapsing to one hour. */
export function toggleAllDay(time: EventTime, zone: string): EventTime {
  if (time.kind === 'allDay') {
    // Keep every occupied day: a multi-day event becomes 09:00 on its first day to 17:00 on its last.
    const last = addDays(time.endDateExclusive, -1);
    return {
      kind: 'timed',
      startLocal: `${time.startDate}T09:00`,
      endLocal: last > time.startDate ? `${last}T17:00` : `${time.startDate}T10:00`,
      timeZone: zone,
    };
  }
  const last = formatLocal(localMillis(time.endLocal)! - 60_000).slice(0, 10);
  const first = time.startLocal.slice(0, 10);
  return {
    kind: 'allDay',
    startDate: first,
    endDateExclusive: addDays(last < first ? first : last, 1),
  };
}
