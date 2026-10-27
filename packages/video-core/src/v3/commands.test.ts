import {
  createAnimation2,
  prepareAnimation2,
  createPreparedAnimationEmbed2,
} from '@editor-platform/animation-core/v2';
import { expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import { fixture } from './fixture.test-support';
import { time } from '../time';
import { assertVideoContentV2 } from '../v2/validation';
import { assertVideoContentV3 } from './validation';
import { videoCommandV3, updateAnimationClipV3 } from './commands';
import type { AnimationClipV3 } from './model';
it('uses the normal timeline and Undo for placement, splitting and exact pin updates', () => {
  const original = fixture();
  const session = new EditorSession(original);
  session.execute(videoCommandV3({ type: 'move', clipId: 'animation-clip', delta: time(1) }));
  session.execute(
    videoCommandV3({
      type: 'split',
      clipId: 'animation-clip',
      at: time(3),
      rightIds: { 'animation-clip': 'right' },
    }),
  );
  expect(session.content.sequence.clips.map((c) => [c.sourceIn, c.sourceOut])).toEqual([
    [time(0), time(2)],
    [time(2), time(4)],
  ]);
  session.undo();
  session.undo();
  expect(session.content).toEqual(original);
  const next = fixture('v2', 123).sequence.clips[0] as AnimationClipV3;
  const old = original.sequence.clips[0] as AnimationClipV3;
  session.execute(updateAnimationClipV3(old.id, old.embed.source, next.embed));
  expect((session.content.sequence.clips[0] as AnimationClipV3).embed.source.versionId).toBe('v2');
  expect(session.content.sequence.clips[0].start).toEqual(time(1));
  expect(() =>
    session.execute(updateAnimationClipV3(old.id, old.embed.source, next.embed)),
  ).toThrow('pin changed');
  session.undo();
  expect(session.content).toEqual(original);
});
it('preserves native JSON snapshots and keeps old readers closed', () => {
  const value = fixture();
  expect(() => assertVideoContentV3(JSON.parse(JSON.stringify(value)))).not.toThrow();
  expect(() => assertVideoContentV2(value)).toThrow();
  expect(() => assertVideoContentV3({ ...value, schema: 'video-core-prototype-v2' })).toThrow();
});
it('rejects overlapping placements, duplicate identities, unknown fields and forged pins', () => {
  const value = fixture();
  const c = value.sequence.clips[0] as AnimationClipV3;
  for (const patch of [
    { id: 'visual' },
    { sourceOut: time(5) },
    { extra: true },
    { embed: { ...c.embed, source: { ...c.embed.source, contentHash: '0'.repeat(64) } } },
  ]) {
    expect(() =>
      assertVideoContentV3({
        ...value,
        sequence: { ...value.sequence, clips: [{ ...c, ...patch }] },
      }),
    ).toThrow();
  }
  expect(() =>
    videoCommandV3({ type: 'insert', clip: { ...c, id: 'overlap' } }).apply(value),
  ).toThrow();
  value.sequence.tracks[0].locked = true;
  expect(() => videoCommandV3({ type: 'move', clipId: c.id, delta: time(1) }).apply(value)).toThrow(
    'Locked',
  );
  expect(() => updateAnimationClipV3(c.id, c.embed.source, c.embed).apply(value)).toThrow('Locked');
});

it('rejects contradictory immutable versions across clips and pin replacement atomically', () => {
  const value = fixture();
  const original = structuredClone(value);
  const conflict = fixture('v1', 123).sequence.clips[0] as AnimationClipV3;
  const clip = value.sequence.clips[0] as AnimationClipV3;
  expect(() =>
    videoCommandV3({ type: 'insert', clip: { ...conflict, id: 'second', start: time(3) } }).apply(
      value,
    ),
  ).toThrow();
  expect(() =>
    updateAnimationClipV3(clip.id, clip.embed.source, conflict.embed).apply(value),
  ).toThrow();
  expect(value).toEqual(original);
  const identical = videoCommandV3({
    type: 'insert',
    clip: { ...clip, id: 'second', start: time(3) },
  }).apply(value);
  expect(identical.sequence.clips).toHaveLength(2);
  const identities = new Map<string, string>();
  assertVideoContentV3(value, identities);
  expect(() => assertVideoContentV3(fixture('v1', 123), identities)).toThrow();
});

it('rejects conflicting retained-source identities across otherwise valid native snapshots', () => {
  const ref = (content: unknown, artifactId: string) => ({
    artifactId,
    versionId: 'v1',
    compositionId: 'root',
    contentHash: prepareAnimation2(content).contentHash,
  });
  const leaf = createAnimation2(),
    changed = createAnimation2();
  changed.compositions[0].name = 'Different immutable contents';
  const embed = (content: typeof leaf, owner: string) => {
    const root = createAnimation2();
    root.sources = [{ ref: ref(content, 'shared'), content }];
    return createPreparedAnimationEmbed2(ref(root, owner), prepareAnimation2(root), owner);
  };
  const value = fixture(),
    clip = value.sequence.clips[0] as AnimationClipV3;
  clip.embed = embed(leaf, 'first');
  assertVideoContentV3(value);
  expect(() =>
    videoCommandV3({
      type: 'insert',
      clip: { ...clip, id: 'second', start: time(3), embed: embed(changed, 'second') },
    }).apply(value),
  ).toThrow();
});
