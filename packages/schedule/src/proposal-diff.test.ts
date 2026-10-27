import { describe, expect, it } from 'vitest';
import { EditorSession, command, reviewProposedCommands } from '@editor-platform/editor-core';
import {
  createEvent,
  createSchedule,
  setEventTime,
  shiftTime,
  type ScheduleDocument,
} from './model';
import { scheduleProposalDiff } from './proposal-diff';

function content(): ScheduleDocument {
  const session = new EditorSession(createSchedule('Asia/Tokyo'));
  session.execute(
    createEvent({
      id: 'review',
      title: 'Design review',
      time: {
        kind: 'timed',
        startLocal: '2026-10-26T10:00',
        endLocal: '2026-10-26T11:00',
        timeZone: 'Asia/Tokyo',
      },
    }),
  );
  return session.content;
}
const review = (d: ScheduleDocument, commands: ReturnType<typeof setEventTime>[]) =>
  reviewProposedCommands(
    { content: d, base: { artifactId: 'schedule', versionId: 'v1' } },
    { id: 'p', summary: 'Moved the review', commands },
    scheduleProposalDiff,
  );

describe('Schedule proposal diff', () => {
  it('reports the period with its time zone and matches the native command', () => {
    const d = content();
    const later = setEventTime('review', shiftTime(d.events[0].time, 1, 30));
    const result = review(d, [later]);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.changes).toEqual([
      expect.objectContaining({
        kind: 'period',
        elementId: 'review',
        units: 'Asia/Tokyo',
        before: expect.objectContaining({ startLocal: '2026-10-26T10:00' }),
        after: expect.objectContaining({ startLocal: '2026-10-27T10:30', timeZone: 'Asia/Tokyo' }),
      }),
    ]);
    const session = new EditorSession(d);
    session.execute(setEventTime('review', shiftTime(d.events[0].time, 1, 30)));
    expect(session.content).toEqual(result.preview.content);
  });
  it('refuses an unknown zone instead of showing a period', () => {
    const d = content();
    const unknown = command<ScheduleDocument>(
      'schedule.setEventTime',
      'Change event time',
      (c) => ({
        ...c,
        events: c.events.map((e) => ({ ...e, time: { ...e.time, timeZone: 'Mars/Olympus' } })),
      }),
    );
    expect(review(d, [unknown])).toMatchObject({
      status: 'refused',
      reason: 'unknown-units',
      elementIds: ['review'],
    });
  });
  it('shows the whole event when one is created or removed', () => {
    const d = content();
    const create = createEvent({
      id: 'sync',
      title: 'Sync',
      notes: 'Bring the plan',
      time: {
        kind: 'timed',
        startLocal: '2026-10-27T09:00',
        endLocal: '2026-10-27T09:30',
        timeZone: 'Asia/Tokyo',
      },
    });
    expect(review(d, [create])).toMatchObject({
      status: 'ready',
      changes: [
        {
          kind: 'added',
          elementId: 'sync',
          after: { notes: 'Bring the plan' },
          units: 'Asia/Tokyo',
        },
      ],
    });
  });
});
