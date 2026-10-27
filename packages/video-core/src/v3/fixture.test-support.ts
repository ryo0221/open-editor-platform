import {
  createAnimation2,
  createAnimationLayer2,
  prepareAnimation2,
  createPreparedAnimationEmbed2,
} from '@editor-platform/animation-core/v2';
import { time } from '../time';
import type { VideoContentV3 } from './model';
export function fixture(version = 'v1', x = 0): VideoContentV3 {
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
