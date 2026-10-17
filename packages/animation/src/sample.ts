import { identityTransform, type AnimationContentV1 } from '@editor-platform/animation-core';
export function newAnimation(): AnimationContentV1 {
  return {
    schemaVersion: 1,
    ticksPerSecond: 240000,
    rootCompositionId: 'root',
    assets: [],
    compositions: [
      {
        id: 'root',
        width: 640,
        height: 360,
        duration: 960000,
        frameRate: { numerator: 30, denominator: 1 },
        layers: [
          {
            id: 'group',
            type: 'group',
            parentId: null,
            start: 0,
            end: 960000,
            transform: identityTransform(),
          },
        ],
        tracks: [],
      },
    ],
  };
}
