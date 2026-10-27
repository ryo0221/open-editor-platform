import { expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import { fixture } from './fixture.test-support';
import { videoCommandV3 } from './commands';
import { assertVideoContentV3 } from './validation';
import { visualOpacityV3 } from './visual-fade';
import { time } from '../time';

it('keeps visual fade source functions through split, trim, move and Undo at rate two', () => {
  const session = new EditorSession(fixture());
  session.execute(
    videoCommandV3({
      type: 'visual-fade',
      clipId: 'animation-clip',
      fadeIn: time(1, 2),
      fadeOut: time(1, 2),
    }),
  );
  const before = structuredClone(session.content);
  const clip = before.sequence.clips[0];
  expect([1, 1.25, 1.5, 2.75].map((t) => visualOpacityV3(clip, time(t * 4, 4)))).toEqual([
    0, 0.5, 1, 0.5,
  ]);
  session.execute(
    videoCommandV3({
      type: 'split',
      clipId: clip.id,
      at: time(2),
      rightIds: { [clip.id]: 'right' },
    }),
  );
  const [left, right] = session.content.sequence.clips;
  expect(visualOpacityV3(left, time(5, 4))).toBe(0.5);
  expect(visualOpacityV3(right, time(11, 4))).toBe(0.5);
  session.execute(
    videoCommandV3({
      type: 'trim',
      clipId: 'right',
      start: time(9, 4),
      end: time(3),
      independent: true,
    }),
  );
  expect(visualOpacityV3(session.content.sequence.clips[1], time(11, 4))).toBe(0.5);
  session.execute(videoCommandV3({ type: 'move', clipId: 'right', delta: time(1) }));
  expect(visualOpacityV3(session.content.sequence.clips[1], time(15, 4))).toBe(0.5);
  session.undo();
  session.undo();
  session.undo();
  expect(session.content).toEqual(before);
  session.undo();
  expect(session.content).toEqual(fixture());
  session.redo();
  expect(session.content).toEqual(before);
});

it('refuses invalid envelopes and locked edits without changing content or pending Redo', () => {
  const session = new EditorSession(fixture());
  session.execute(
    videoCommandV3({
      type: 'visual-fade',
      clipId: 'animation-clip',
      fadeIn: time(1),
      fadeOut: time(1),
    }),
  );
  session.undo();
  const before = structuredClone(session.content);
  for (const [fadeIn, fadeOut] of [
    [time(-1), time(0)],
    [time(2), time(1)],
  ]) {
    expect(() =>
      session.execute(
        videoCommandV3({ type: 'visual-fade', clipId: 'animation-clip', fadeIn, fadeOut }),
      ),
    ).toThrow();
    expect(session.content).toEqual(before);
  }
  session.redo();
  expect(session.content).not.toEqual(before);
  const locked = fixture();
  locked.sequence.tracks[0].locked = true;
  expect(() =>
    videoCommandV3({
      type: 'visual-fade',
      clipId: 'animation-clip',
      fadeIn: time(0),
      fadeOut: time(0),
    }).apply(locked),
  ).toThrow('Locked');
  expect(() =>
    assertVideoContentV3({
      ...before,
      sequence: {
        ...before.sequence,
        clips: [{ ...before.sequence.clips[0], visualFade: { extra: true } }],
      },
    }),
  ).toThrow();
});

it('evaluates admitted wide anchor fractions without serialized Time intermediates', () => {
  const value = fixture();
  const clip = value.sequence.clips[0];
  if (clip.kind === 'audio') throw Error();
  const max = Number.MAX_SAFE_INTEGER;
  clip.visualFade = { start: time(1, max), end: time(1), in: time(1, 2), out: time(0) };
  assertVideoContentV3(value);
  const bytes = JSON.stringify(value);
  expect(visualOpacityV3(clip, time(26, 25))).toBe(
    Number((2n * BigInt(max) - 25n) * 2n) / Number(25n * BigInt(max)),
  );
  expect(visualOpacityV3(clip, time(1))).toBe(0);
  expect(visualOpacityV3(clip, time(3, 2))).toBe(0);
  expect(JSON.stringify(value)).toBe(bytes);
  clip.visualFade = { start: time(0), end: time(1, max), in: time(0), out: time(1, max) };
  assertVideoContentV3(value);
  expect(visualOpacityV3(clip, time(1))).toBe(1);
  expect(visualOpacityV3(clip, time(26, 25))).toBe(0);
});
