import { expect, it } from 'vitest';
import {
  time,
  videoCommandV3,
  type AnimationClipV3,
  type VideoContentV3,
} from '@editor-platform/video-core';
import {
  evaluateAnimation2,
  prepareAnimation2,
  createAnimation2,
  createAnimationLayer2,
  createPreparedAnimationEmbed2,
} from '@editor-platform/animation-core/v2';
import { prepareAnimationTimelineV3 } from './timeline-v3';
function fixture(version = 'v1', x = 0): VideoContentV3 {
  const animation = createAnimation2();
  animation.compositions[0].layers = [createAnimationLayer2('rect', 'box', 960000)];
  animation.compositions[0].layers[0].transform.x = x;
  const prepared = prepareAnimation2(animation);
  const embed = createPreparedAnimationEmbed2(
    {
      artifactId: 'animation',
      versionId: version,
      contentHash: prepared.contentHash,
      compositionId: 'root',
    },
    prepared,
    'Pinned',
  );
  return {
    schema: 'video-core-prototype-v3',
    sources: [],
    sequence: {
      id: 'sequence',
      duration: time(6),
      frameRate: time(25),
      tracks: [{ id: 'visual', kind: 'visual', enabled: true, locked: false }],
      clips: [
        {
          id: 'animation-clip',
          kind: 'animation',
          trackId: 'visual',
          start: time(1),
          duration: time(2),
          sourceIn: time(0),
          sourceOut: time(4),
          rate: time(2),
          embed,
        },
      ],
    },
  };
}

it('samples native poses at placement/rate coordinates with half-open boundaries', () => {
  const value = fixture(),
    clip = value.sequence.clips[0] as AnimationClipV3;
  const timeline = prepareAnimationTimelineV3(value);
  expect(timeline.sample(time(0))).toEqual([]);
  expect(timeline.sample(time(3))).toEqual([]);
  expect(timeline.sample(time(2))[0].scene).toEqual(
    evaluateAnimation2(prepareAnimation2(clip.embed.snapshot), 'root', 480000),
  );
  expect(timeline.sample(time(1))[0].source.versionId).toBe('v1');
  value.sequence.clips.length = 0;
  expect(timeline.sample(time(2))).toHaveLength(1);
});
it('split preserves native pose and disabled tracks produce no scene', () => {
  const value = fixture();
  const edited = videoCommandV3({
    type: 'split',
    clipId: 'animation-clip',
    at: time(2),
    rightIds: { 'animation-clip': 'right' },
  }).apply(value);
  const pose = prepareAnimationTimelineV3(edited).sample(time(5, 2));
  expect(pose[0].clipId).toBe('right');
  expect(pose[0].scene).toEqual(prepareAnimationTimelineV3(value).sample(time(5, 2))[0].scene);
  edited.sequence.tracks[0].enabled = false;
  expect(prepareAnimationTimelineV3(edited).sample(time(5, 2))).toEqual([]);
});
it('refuses fractional native ticks instead of approximating preview/export', () => {
  expect(() => prepareAnimationTimelineV3(fixture()).sample(time(8, 7))).toThrow('fractional tick');
});
