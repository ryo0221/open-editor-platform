import { SCHEMA, identityTransform, type PrototypeAnimationContent } from './model';
/** Small golden fixture; not a performance workload. */
export function animationFixture(): PrototypeAnimationContent {
  return {
    schemaVersion: SCHEMA,
    ticksPerSecond: 240000,
    rootCompositionId: 'root',
    assets: [],
    compositions: [
      {
        id: 'root',
        width: 640,
        height: 360,
        duration: 240000,
        frameRate: { numerator: 30000, denominator: 1001 },
        layers: [
          {
            id: 'box',
            parentId: null,
            start: 0,
            end: 240000,
            type: 'rect',
            width: 20,
            height: 10,
            fill: '#ff0000',
            transform: identityTransform(),
          },
        ],
        tracks: [
          {
            id: 'move',
            layerId: 'box',
            property: 'x',
            keys: [
              { id: 'first', tick: 0, value: 10, easing: { type: 'linear' } },
              { id: 'last', tick: 240000, value: 110, easing: { type: 'hold' } },
            ],
          },
        ],
      },
    ],
  };
}
