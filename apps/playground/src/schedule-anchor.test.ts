import { describe, expect, it } from 'vitest';
import { createEvent, createSchedule } from '@editor-platform/schedule/model';
import { EditorSession } from '@editor-platform/editor-core';
import { anchorState } from './model';

describe('Schedule annotation anchors', () => {
  it('keeps a comment on an existing event current and orphans it once the event is gone', () => {
    const session = new EditorSession(createSchedule('UTC'));
    session.execute(
      createEvent({
        id: 'event-1',
        title: 'Review',
        time: {
          kind: 'timed',
          startLocal: '2026-10-27T10:00',
          endLocal: '2026-10-27T11:00',
          timeZone: 'UTC',
        },
      }),
    );
    expect(anchorState(session.content, { artifactId: 'a1', elementId: 'event-1' })).toBe(
      'Current',
    );
    expect(anchorState(session.content, { artifactId: 'a1', elementId: 'event-gone' })).toBe(
      'Orphan',
    );
  });
});
