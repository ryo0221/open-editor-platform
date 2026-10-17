import {
  SCHEMA,
  identityTransform,
  type PrototypeAnimationContent,
} from '@editor-platform/animation-core';
/** Retained sample prototype; migration must be an explicit Host action. */
export function rectanglePrototypeFixture(): PrototypeAnimationContent {
  return {
    schemaVersion: SCHEMA,
    ticksPerSecond: 48000,
    rootCompositionId: 'root',
    assets: [],
    compositions: [
      {
        id: 'root',
        width: 320,
        height: 180,
        duration: 48000,
        frameRate: { numerator: 24, denominator: 1 },
        layers: [
          {
            id: 'group',
            type: 'group',
            parentId: null,
            start: 0,
            end: 48000,
            transform: { ...identityTransform(), x: 8 },
          },
          {
            id: 'box',
            type: 'rect',
            parentId: 'group',
            start: 0,
            end: 48000,
            width: 60,
            height: 40,
            fill: '#2563eb',
            transform: { ...identityTransform(), y: 30, opacity: 0.75 },
          },
        ],
        tracks: [
          {
            id: 'x',
            layerId: 'box',
            property: 'x',
            keys: [
              { id: 'start', tick: 0, value: 10, easing: { type: 'linear' } },
              { id: 'end', tick: 48000, value: 210, easing: { type: 'hold' } },
            ],
          },
        ],
      },
    ],
  };
}
