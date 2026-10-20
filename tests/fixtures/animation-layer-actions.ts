import { createRectangleAnimation, identityTransform } from '@editor-platform/animation-core';

/** Deliberately interleaved, child-first native paint order; not a performance workload. */
export function animationLayerActionsFixture() {
  const content = createRectangleAnimation();
  const composition = content.compositions[0];
  const common = { start: 0, end: composition.duration, transform: identityTransform() };
  composition.layers = [
    {
      ...structuredClone(common),
      id: 'child',
      type: 'rect',
      parentId: 'inner',
      width: 100,
      height: 60,
      fill: '#e87945',
      transform: { ...identityTransform(), x: 25, y: 60 },
    },
    {
      ...structuredClone(common),
      id: 'outside',
      type: 'rect',
      parentId: null,
      width: 100,
      height: 60,
      fill: '#818cf8',
      transform: { ...identityTransform(), x: 350, y: 100 },
    },
    { ...structuredClone(common), id: 'inner', type: 'group', parentId: 'group' },
    {
      ...structuredClone(common),
      id: 'group',
      type: 'group',
      parentId: 'parent',
      transform: { ...identityTransform(), x: 40 },
    },
    { ...structuredClone(common), id: 'parent', type: 'group', parentId: null },
    {
      ...structuredClone(common),
      id: 'sibling',
      type: 'rect',
      parentId: 'parent',
      width: 80,
      height: 40,
      fill: '#34d399',
      transform: { ...identityTransform(), x: 150, y: 180 },
    },
  ];
  composition.tracks = [
    {
      id: 'child-x',
      layerId: 'child',
      property: 'x',
      keys: [
        {
          id: 'child-start',
          tick: 0,
          value: 25,
          easing: { type: 'bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
        },
        { id: 'child-end', tick: composition.duration, value: 180, easing: { type: 'hold' } },
      ],
    },
    {
      id: 'group-opacity',
      layerId: 'group',
      property: 'opacity',
      keys: [
        { id: 'group-start', tick: 0, value: 1, easing: { type: 'linear' } },
        { id: 'group-end', tick: composition.duration, value: 0.5, easing: { type: 'hold' } },
      ],
    },
    {
      id: 'outside-x',
      layerId: 'outside',
      property: 'x',
      keys: [
        { id: 'outside-start', tick: 0, value: 350, easing: { type: 'linear' } },
        { id: 'outside-end', tick: composition.duration, value: 400, easing: { type: 'hold' } },
      ],
    },
  ];
  content.compositions.push({
    ...structuredClone(composition),
    id: 'other-composition',
    layers: [{ ...structuredClone(composition.layers[1]), id: 'other-layer' }],
    tracks: [],
  });
  return content;
}
