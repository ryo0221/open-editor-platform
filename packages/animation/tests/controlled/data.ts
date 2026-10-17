import { identityTransform, type AnimationContentV1 } from '@editor-platform/animation-core';
export const controlledFixture = (): AnimationContentV1 => ({
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
          id: 'box',
          type: 'rect',
          parentId: null,
          start: 0,
          end: 960000,
          width: 80,
          height: 80,
          fill: '#818cf8',
          transform: { ...identityTransform(), x: 80, y: 140 },
        },
      ],
      tracks: [
        {
          id: 'x-track',
          layerId: 'box',
          property: 'x',
          keys: [
            { id: 'a', tick: 0, value: 80, easing: { type: 'linear' } },
            { id: 'b', tick: 960000, value: 400, easing: { type: 'linear' } },
          ],
        },
      ],
    },
  ],
});

export function controlledMultiFixture(): AnimationContentV1 {
  const content = controlledFixture();
  const root = content.compositions[0];
  root.layers.push({ ...structuredClone(root.layers[0]), id: 'other-box' });
  content.compositions.push({
    ...structuredClone(root),
    id: 'other-composition',
    layers: [{ ...structuredClone(root.layers[0]), id: 'second-box' }],
    tracks: [],
  });
  return content;
}
