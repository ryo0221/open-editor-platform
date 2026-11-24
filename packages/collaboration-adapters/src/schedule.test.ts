import { expect, it } from 'vitest';
import { Authority, initial, type Principal } from '@editor-platform/collaboration-core';
import {
  createEvent,
  createSchedule,
  setEventTime,
  updateEventText,
  type AllDayTime,
} from '@editor-platform/schedule/model';
import { prepareEditorCommand, scheduleEditorCodec as codec } from './index';

const principal = (id: string): Principal => ({
  actorId: id,
  clientId: id,
  sessionId: id,
  writable: true,
  scopes: ['*'],
});
const a = principal('a'),
  b = principal('b');
const original: AllDayTime = {
  kind: 'allDay',
  startDate: '2026-07-01',
  endDateExclusive: '2026-07-02',
};

it('combines a reschedule and a notes edit, rejects competing time changes and undoes only the time', () => {
  const content = createEvent({ id: 'meeting', title: 'Meeting', time: original }).apply(
    createSchedule(),
  );
  const snapshot = initial('calendar', codec, content);
  const authority = new Authority(codec, snapshot);
  const move = (actor: Principal, day: string, end: string) =>
    prepareEditorCommand(
      codec,
      snapshot,
      actor,
      setEventTime('meeting', {
        kind: 'allDay',
        startDate: day,
        endDateExclusive: end,
      }),
    )!;
  const first = move(a, '2026-07-02', '2026-07-03');
  const second = move(b, '2026-07-03', '2026-07-04');
  const notes = prepareEditorCommand(
    codec,
    snapshot,
    b,
    updateEventText('meeting', { notes: 'Bring notes' }),
  )!;
  expect(authority.submit(a, first).status).toBe('accepted');
  expect(authority.submit(b, notes).status).toBe('accepted');
  expect(authority.submit(b, second)).toMatchObject({
    status: 'rejected',
    code: 'stale-precondition',
  });
  expect(authority.undo(a, first.operationId).status).toBe('accepted');
  expect(authority.snapshot().content.events[0]).toMatchObject({
    time: original,
    notes: 'Bring notes',
  });
});

it('rejects lane references even when sent as a direct edit', () => {
  const content = createSchedule();
  expect(() =>
    codec.apply(
      content,
      {
        type: 'schedule.edit',
        target: '*',
        payload: {
          changes: [{ kind: 'insert', collection: 'lanes', id: 'lane', value: { id: 'lane' } }],
          reads: [],
        },
      },
      0,
    ),
  ).toThrow(/collection is missing/);
});
