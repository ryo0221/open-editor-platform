import { expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import { fixture } from './fixture.test-support';
import { videoCommandV3 } from './commands';
it('uses explicit native track order, assignment and the existing Undo history', () => {
  const session = new EditorSession(fixture());
  session.execute(videoCommandV3({ type: 'visual-track-add', trackId: 'overlay' }));
  session.execute(
    videoCommandV3({ type: 'visual-track-assign', trackId: 'overlay', clipId: 'animation-clip' }),
  );
  expect(session.content.sequence.clips[0].trackId).toBe('overlay');
  session.execute(
    videoCommandV3({ type: 'visual-track-shift', trackId: 'overlay', direction: -1 }),
  );
  expect(session.content.sequence.tracks.map((t) => t.id)).toEqual(['overlay', 'visual']);
  session.undo();
  session.undo();
  session.undo();
  expect(session.content).toEqual(fixture());
  session.redo();
  session.redo();
  session.redo();
  expect(session.content.sequence.tracks[0].id).toBe('overlay');
});
it('refuses duplicate IDs, locked neighbors, invalid assignment and overlapping same-track clips atomically', () => {
  const initial = fixture();
  expect(() =>
    videoCommandV3({ type: 'visual-track-add', trackId: 'visual' }).apply(initial),
  ).toThrow('Duplicate');
  const value = videoCommandV3({ type: 'visual-track-add', trackId: 'overlay' }).apply(initial);
  value.sequence.tracks[0].locked = true;
  expect(() =>
    videoCommandV3({ type: 'visual-track-shift', trackId: 'overlay', direction: -1 }).apply(value),
  ).toThrow('locked');
  expect(() =>
    videoCommandV3({
      type: 'visual-track-assign',
      trackId: 'overlay',
      clipId: 'animation-clip',
    }).apply(value),
  ).toThrow('Locked');
  value.sequence.tracks[0].locked = false;
  value.sequence.clips.push({
    ...structuredClone(value.sequence.clips[0]),
    id: 'second',
    trackId: 'overlay',
  });
  const before = JSON.stringify(value);
  expect(() =>
    videoCommandV3({ type: 'visual-track-assign', trackId: 'visual', clipId: 'second' }).apply(
      value,
    ),
  ).toThrow('Overlapping');
  expect(JSON.stringify(value)).toBe(before);
});
