import { expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import { time } from '../time';
import type { VideoContentV3, DissolveV3 } from './model';
import { assertVideoContentV3 } from './validation';
import { videoCommandV3 } from './commands';
import { fixture as animationFixture } from './fixture.test-support';
import { visualOpacityV3 } from './visual-fade';
import { evaluateVisualV3 } from './dissolve';
function fixture(): VideoContentV3 {
  return {
    schema: 'video-core-prototype-v3',
    sources: ['s1', 's2'].map((id) => ({
      id,
      asset: { assetId: id, sha256: (id === 's1' ? 'a' : 'b').repeat(64), byteLength: 100 },
      streams: [
        {
          id: 'v',
          kind: 'video',
          timebase: time(1, 25),
          startPts: 0,
          endPts: 200,
          presentationOrigin: time(0),
        },
      ],
    })),
    sequence: {
      id: 'seq',
      duration: time(4),
      frameRate: time(25),
      tracks: [{ id: 'track', kind: 'visual', enabled: true, locked: false }],
      clips: ['s1', 's2'].map((sourceId, i) => ({
        id: 'c' + i,
        kind: 'video',
        sourceId,
        streamId: 'v',
        trackId: 'track',
        start: time(i * 2),
        duration: time(2),
        sourceIn: time(1),
        sourceOut: time(3),
        rate: time(1),
      })),
    },
  };
}
const edge: DissolveV3 = {
  id: 'edge',
  kind: 'cross-dissolve',
  leftClipId: 'c0',
  rightClipId: 'c1',
  duration: time(1),
};
it('keeps the cut fixed, evaluates both sources around it and edits edge metadata in the same Undo', () => {
  const original = fixture(),
    session = new EditorSession(original);
  session.execute(videoCommandV3({ type: 'dissolve-set', edge }));
  const withEdge = structuredClone(session.content);
  expect(withEdge.sequence.clips).toEqual(original.sequence.clips);
  expect(withEdge.sequence.duration).toEqual(original.sequence.duration);
  expect([...evaluateVisualV3(withEdge, time(3, 2)).active]).toEqual(['c0', 'c1']);
  expect(evaluateVisualV3(withEdge, time(2)).edges[0].progress).toBe(0.5);
  expect([...evaluateVisualV3(withEdge, time(5, 2)).active]).toEqual(['c1']);
  session.execute(
    videoCommandV3({ type: 'split', clipId: 'c0', at: time(1), rightIds: { c0: 'right' } }),
  );
  expect(session.content.sequence.transitions![0].leftClipId).toBe('right');
  session.undo();
  expect(session.content).toEqual(withEdge);
  expect(() =>
    session.execute(
      videoCommandV3({ type: 'split', clipId: 'c0', at: time(7, 4), rightIds: { c0: 'short' } }),
    ),
  ).toThrow('window exceeds');
  expect(session.content).toEqual(withEdge);
  session.execute(videoCommandV3({ type: 'delete', clipId: 'c0' }));
  expect(session.content.sequence.transitions).toBeUndefined();
  session.undo();
  expect(session.content).toEqual(withEdge);
  session.execute(videoCommandV3({ type: 'dissolve-remove', edgeId: 'edge' }));
  expect(session.content).toEqual(original);
});
it('refuses insufficient timed handles, invalid IDs and locked endpoints without partial changes', () => {
  const original = fixture();
  const right = original.sequence.clips[1];
  if (right.kind !== 'video') throw Error('fixture');
  right.sourceIn = time(0);
  right.sourceOut = time(2);
  assertVideoContentV3(original);
  expect(() => videoCommandV3({ type: 'dissolve-set', edge }).apply(original)).toThrow(
    'Insufficient dissolve source handle',
  );
  expect(original.sequence.transitions).toBeUndefined();
  const valid = fixture();
  valid.sequence.tracks[0].locked = true;
  expect(() => videoCommandV3({ type: 'dissolve-set', edge }).apply(valid)).toThrow('locked');
  expect(() =>
    videoCommandV3({ type: 'dissolve-set', edge: { ...edge, id: 's1' } }).apply(fixture()),
  ).toThrow('ID');
});

it('checks finite Animation handles and retains a fade-in-only envelope beyond the outgoing cut', () => {
  const content = animationFixture();
  const left = content.sequence.clips[0];
  if (left.kind !== 'animation') throw Error('fixture');
  left.rate = time(1);
  left.duration = time(1);
  left.sourceIn = time(1);
  left.sourceOut = time(2);
  const right = { ...structuredClone(left), id: 'right', start: time(2) };
  content.sequence.clips.push(right);
  const result = videoCommandV3({
    type: 'dissolve-set',
    edge: { ...edge, leftClipId: left.id, rightClipId: right.id },
  }).apply(content);
  expect(evaluateVisualV3(result, time(2)).active.size).toBe(2);
  right.sourceIn = time(0);
  right.sourceOut = time(1);
  expect(() =>
    videoCommandV3({
      type: 'dissolve-set',
      edge: { ...edge, leftClipId: left.id, rightClipId: right.id },
    }).apply(content),
  ).toThrow('Insufficient');
  const faded = {
    ...left,
    visualFade: { start: time(1), end: time(2), in: time(1, 4), out: time(0) },
  };
  expect(visualOpacityV3(faded, time(9, 4), true)).toBe(1);
  expect(visualOpacityV3(faded, time(9, 4))).toBe(0);
});

it('rejects explicit null transition data instead of silently treating it as no edges', () => {
  const invalid = fixture();
  Object.assign(invalid.sequence, { transitions: null });
  expect(() => assertVideoContentV3(invalid)).toThrow('Dissolve edges must be an array');
});

it('refuses a third same-source frame before committing a dissolve and when re-enabling a track', () => {
  const content = fixture();
  const right = content.sequence.clips[1];
  if (right.kind !== 'video') throw Error('fixture');
  right.sourceId = 's1';
  content.sequence.tracks.push({ id: 'overlay', kind: 'visual', enabled: true, locked: false });
  content.sequence.clips.push({
    ...structuredClone(right),
    id: 'overlay-clip',
    trackId: 'overlay',
    start: time(0),
    duration: time(4),
    sourceIn: time(0),
    sourceOut: time(4),
  });
  assertVideoContentV3(content);
  const session = new EditorSession(content);
  expect(() => session.execute(videoCommandV3({ type: 'dissolve-set', edge }))).toThrow(
    'source frame admission',
  );
  expect(session.content).toEqual(content);
  content.sequence.tracks[1].enabled = false;
  const valid = videoCommandV3({ type: 'dissolve-set', edge }).apply(content);
  assertVideoContentV3(valid);
  valid.sequence.tracks[1].enabled = true;
  expect(() => assertVideoContentV3(valid)).toThrow('source frame admission');
  const overlay = valid.sequence.clips[2];
  overlay.start = time(5, 2);
  overlay.duration = time(3, 2);
  overlay.sourceOut = time(3, 2);
  expect(() => assertVideoContentV3(valid)).not.toThrow();
});
