import { describe, expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import { canonicalJson, deepFreeze } from '@editor-platform/artifact-core';
import {
  addLane,
  assertSchedule,
  createEvent,
  createSchedule,
  duplicateEvent,
  isSchedule,
  removeEvent,
  removeLane,
  setEventTime,
  setRecordLinks,
  shiftTime,
  timedInstants,
  toggleAllDay,
  updateEventText,
  type ScheduleDocument,
  type ScheduleError,
  type TimedTime,
} from './model';
import { canonicalZone, resolveLocal, wallTime } from './zone';
import { syntheticLane } from './test-fixtures';
import { placeEvents } from './view-model';
import { historyDropsDetails, historyDropsDetailsText, stepScheduleHistory } from './history';
import { utcDay } from '@editor-platform/time-axis';

const timed = (start: string, end: string, timeZone = 'Asia/Tokyo'): TimedTime => ({
  kind: 'timed',
  startLocal: start,
  endLocal: end,
  timeZone,
});

describe('Schedule model', () => {
  it('creates, edits and undoes events with stable IDs', () => {
    const session = new EditorSession<ScheduleDocument>(createSchedule('Asia/Tokyo'));
    session.execute(createEvent({ id: 'e1', time: timed('2026-10-26T10:00', '2026-10-26T11:00') }));
    session.execute(updateEventText('e1', { title: 'Design review' }));
    session.execute(setEventTime('e1', timed('2026-10-27T10:00', '2026-10-27T11:00')));
    expect(session.content.events).toEqual([
      expect.objectContaining({ id: 'e1', title: 'Design review' }),
    ]);
    session.undo();
    expect(session.content.events[0].time).toEqual(timed('2026-10-26T10:00', '2026-10-26T11:00'));
    session.undo();
    expect(session.content.events[0].title).toBe('New event');
    session.execute(duplicateEvent('e1', 'e2'));
    expect(session.content.events.map((e) => e.id)).toEqual(['e1', 'e2']);
    session.execute(removeEvent('e1'));
    expect(session.content.events.map((e) => e.id)).toEqual(['e2']);
  });

  it('rejects missing, ambiguous and reversed wall times and unknown zones', () => {
    const ny = 'America/New_York';
    expect(resolveLocal('2026-03-08T02:30', ny).kind).toBe('missing');
    const fold = resolveLocal('2026-11-01T01:30', ny);
    expect(fold.kind).toBe('ambiguous');
    if (fold.kind === 'ambiguous') expect(fold.later - fold.earlier).toBe(3_600_000);
    const base = createSchedule(ny);
    expect(() =>
      createEvent({ time: timed('2026-03-08T02:30', '2026-03-08T03:30', ny) }).apply(base),
    ).toThrow(/does not exist/);
    expect(() =>
      createEvent({ time: timed('2026-11-01T01:30', '2026-11-01T03:00', ny) }).apply(base),
    ).toThrow(/occurs twice/);
    const chosen = {
      ...timed('2026-11-01T01:30', '2026-11-01T03:00', ny),
      startFold: 'later' as const,
    };
    expect(timedInstants(chosen).end - timedInstants(chosen).start).toBe(90 * 60_000);
    // A time error names the wall time it is about, so the form marks that one field.
    const field = (time: TimedTime) => {
      try {
        timedInstants(time);
      } catch (error) {
        return (error as ScheduleError).field;
      }
    };
    expect(field(timed('2026-11-01T01:30', '2026-11-01T03:00', ny))).toBe('start');
    expect(field(timed('2026-11-01T00:30', '2026-11-01T01:30', ny))).toBe('end');
    expect(field(timed('2026-03-08T01:00', '2026-03-08T02:30', ny))).toBe('end');
    expect(() =>
      createEvent({ time: timed('2026-10-26T11:00', '2026-10-26T10:00') }).apply(base),
    ).toThrow(/after the start/);
    expect(() =>
      createEvent({ time: timed('2026-10-26T10:00', '2026-10-26T11:00', 'Mars/Base') }).apply(base),
    ).toThrow(/Unknown time zone/);
    expect(canonicalZone('Mars/Base')).toBeNull();
  });

  it('keeps all-day dates and event times independent of the display zone', () => {
    const content = createEvent({
      id: 'a',
      time: { kind: 'allDay', startDate: '2026-10-26', endDateExclusive: '2026-10-27' },
    }).apply(createSchedule('Pacific/Kiritimati'));
    const json = JSON.parse(canonicalJson(content));
    expect(json.events[0].time).toEqual({
      kind: 'allDay',
      startDate: '2026-10-26',
      endDateExclusive: '2026-10-27',
    });
    const instant = timedInstants(timed('2026-10-26T10:00', '2026-10-26T11:00')).start;
    expect(wallTime(instant, 'America/Los_Angeles')).toEqual({ date: '2026-10-25', minutes: 1080 });
    expect(wallTime(instant, 'Asia/Tokyo')).toEqual({ date: '2026-10-26', minutes: 600 });
  });

  it('shifts in wall-clock time and drops a stale fold', () => {
    const t = {
      ...timed('2026-11-01T01:30', '2026-11-01T03:00', 'America/New_York'),
      startFold: 'earlier' as const,
    };
    expect(shiftTime(t, 1)).toEqual(
      timed('2026-11-02T01:30', '2026-11-02T03:00', 'America/New_York'),
    );
    expect(shiftTime(timed('2026-10-26T23:45', '2026-10-27T00:15'), 0, 15)).toEqual(
      timed('2026-10-27T00:00', '2026-10-27T00:30'),
    );
    expect(
      shiftTime({ kind: 'allDay', startDate: '2026-10-31', endDateExclusive: '2026-11-01' }, 1),
    ).toEqual({ kind: 'allDay', startDate: '2026-11-01', endDateExclusive: '2026-11-02' });
  });

  it('validates the whole document and rejects unsupported fields', () => {
    const lane = syntheticLane();
    const good = setRecordLinks('e1', [{ laneId: lane.id, rowId: 'row-1' }]).apply(
      createEvent({ id: 'e1', time: timed('2026-10-26T10:00', '2026-10-26T11:00') }).apply(
        addLane(lane).apply(createSchedule('Asia/Tokyo')),
      ),
    );
    expect(isSchedule(good)).toBe(true);
    const bad = (mutate: (value: ScheduleDocument & Record<string, unknown>) => void) => {
      const value = structuredClone(good) as ScheduleDocument & Record<string, unknown>;
      mutate(value);
      return () => assertSchedule(value);
    };
    expect(bad((v) => v.events.push(structuredClone(v.events[0])))).toThrow(/Duplicate event ID/);
    expect(bad((v) => ((v as { schemaVersion: number }).schemaVersion = 2))).toThrow(/Unsupported/);
    expect(
      bad((v) => ((v.events[0] as unknown as Record<string, unknown>).participants = [])),
    ).toThrow(/Invalid event/);
    expect(bad((v) => (v.events[0].title = 'x'.repeat(513)))).toThrow(/too long/);
    expect(bad((v) => (v.events[0].notes = 'a\u0007b'))).toThrow(/control characters/);
    expect(bad((v) => (v.events[0].links[0].laneId = 'missing'))).toThrow(/related record/);
    expect(bad((v) => (v.extra = true))).toThrow(/Unsupported/);
    expect(
      bad((v) => {
        v.events = Array.from({ length: 2001 }, (_, i) => ({
          ...v.events[0],
          id: `e${i}`,
          links: [],
        }));
      }),
    ).toThrow(/Too many/);
    // Removing a lane removes its links in the same edit.
    expect(removeLane(lane.id).apply(good).events[0].links).toEqual([]);
  });

  it('keeps every occupied day when All day is turned on and off', () => {
    const offsite = {
      kind: 'allDay' as const,
      startDate: '2026-10-28',
      endDateExclusive: '2026-10-31',
    };
    const timedOffsite = toggleAllDay(offsite, 'Asia/Tokyo');
    expect(timedOffsite).toMatchObject({
      startLocal: '2026-10-28T09:00',
      endLocal: '2026-10-30T17:00',
    });
    expect(toggleAllDay(timedOffsite, 'Asia/Tokyo')).toEqual(offsite);
    expect(
      toggleAllDay(
        { kind: 'allDay', startDate: '2026-10-28', endDateExclusive: '2026-10-29' },
        'UTC',
      ),
    ).toMatchObject({ startLocal: '2026-10-28T09:00', endLocal: '2026-10-28T10:00' });
  });
});

describe('Schedule at 2000 events', () => {
  const zones = ['Asia/Tokyo', 'America/New_York', 'Europe/London', 'UTC'];
  function large(count: number) {
    let doc = createSchedule('Asia/Tokyo');
    const events = Array.from({ length: count }, (_, i) => {
      const day = String(1 + (i % 28)).padStart(2, '0');
      return {
        id: `event-${i}`,
        title: `Synthetic ${i}`,
        notes: '',
        time: timed(`2026-10-${day}T10:00`, `2026-10-${day}T11:00`, zones[i % 4]),
        conference: 'none' as const,
        links: [],
      };
    });
    // Frozen like EditorSession content, so validation and placement are remembered.
    doc = deepFreeze({ ...doc, events });
    assertSchedule(doc);
    return doc;
  }

  it('checks and places again only the event an edit changed', () => {
    const doc = large(2000);
    const before = placeEvents(doc, 'Asia/Tokyo');
    const target = doc.events[5];
    const started = performance.now();
    const next = setEventTime(target.id, shiftTime(target.time, 1, 0)).apply(doc);
    const after = placeEvents(next, 'Asia/Tokyo');
    const elapsed = performance.now() - started;
    // Unchanged events keep their placement objects; only the edited one is placed again.
    const reused = after.filter((p) => before.includes(p));
    expect(reused).toHaveLength(1999);
    expect(after.find((p) => p.event.id === target.id)!.startDay).toBe(
      before.find((p) => p.event.id === target.id)!.startDay + 1,
    );
    // A full check and placement took about 400 ms here; an edit now takes about 10 ms.
    expect(elapsed).toBeLessThan(150);
  });

  it('checks and places an event that is not frozen in full every time', () => {
    const doc = structuredClone(large(20));
    placeEvents(doc, 'UTC');
    (doc.events[0] as { title: string }).title = 'x'.repeat(513);
    expect(isSchedule(doc)).toBe(false);
    (doc.events[0] as { title: string }).title = 'Fixed';
    (doc.events[1] as unknown as Record<string, unknown>).extra = undefined;
    expect(isSchedule(doc)).toBe(false);
    delete (doc.events[1] as unknown as Record<string, unknown>).extra;
    expect(isSchedule(doc)).toBe(true);
    // A placement follows a time changed in place too.
    const moved = doc.events[2];
    (moved as { time: TimedTime }).time = timed('2026-10-20T10:00', '2026-10-20T11:00', 'UTC');
    expect(placeEvents(doc, 'UTC').find((p) => p.event === moved)!.startDay).toBe(
      utcDay('2026-10-20'),
    );
  });

  it('still rejects a changed event that breaks the rules inside a large Schedule', () => {
    const doc = large(2000);
    const broken = {
      ...doc,
      events: doc.events.map((e, i) =>
        i === 7 ? { ...e, time: timed('2026-10-08T11:00', '2026-10-08T10:00') } : e,
      ),
    };
    expect(() => assertSchedule(broken)).toThrow();
    // An event checked against one set of lanes is checked again when the lanes change.
    const lane = syntheticLane();
    const linked = deepFreeze({ ...doc.events[0], links: [{ laneId: lane.id, rowId: 'row-1' }] });
    assertSchedule({ ...doc, lanes: [lane], events: [linked] });
    expect(() => assertSchedule({ ...doc, events: [linked] })).toThrow();
  });
});

describe('Schedule history and open details', () => {
  it('flags history that removes an event while details hold unsaved text', () => {
    const doc = createEvent({
      id: 'e1',
      time: timed('2026-10-26T10:00', '2026-10-26T11:00'),
    }).apply(createSchedule('Asia/Tokyo'));
    const empty = createSchedule('Asia/Tokyo');
    const refused = { dirty: 1, composing: 0 };
    expect(historyDropsDetails(doc, empty, refused)).toBe(true);
    expect(historyDropsDetails(doc, empty, { dirty: 0, composing: 1 })).toBe(true);
    // Clean details, or history that keeps every event, lose nothing.
    expect(historyDropsDetails(doc, empty, { dirty: 0, composing: 0 })).toBe(false);
    expect(historyDropsDetails(empty, doc, refused)).toBe(false);
    expect(historyDropsDetails(doc, doc, refused)).toBe(false);
  });

  it('refuses an Undo that drops the open details before the history moves', () => {
    const session = new EditorSession(createSchedule('Asia/Tokyo'));
    const doc = session.executeView(
      createEvent({ id: 'e1', time: timed('2026-10-26T10:00', '2026-10-26T11:00') }),
    );
    const refused = { dirty: 1, composing: 0 };
    expect(stepScheduleHistory(session, 'undo', doc, refused)).toEqual({
      refused: historyDropsDetailsText,
    });
    // Nothing moved: the event is still there and Redo has nothing to restore.
    expect(session.content.events.map((e) => e.id)).toEqual(['e1']);
    expect(session.canRedo).toBe(false);
    const step = stepScheduleHistory(session, 'undo', doc, { dirty: 0, composing: 0 });
    expect('content' in step && step.content.events).toEqual([]);
    expect('content' in step && Object.isFrozen(step.content)).toBe(true);
  });
});
