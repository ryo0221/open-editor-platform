import { it, expect } from 'vitest';
import {
  prepareAnimation,
  evaluateAnimation,
  SCHEMA,
  identityTransform,
} from '@editor-platform/animation-core';
import { createControlledAnimationPlayer } from './index';
it('controlled scene Player matches evaluator across seek order without content/history changes', async () => {
  const source = {
    schemaVersion: SCHEMA,
    ticksPerSecond: 240000,
    rootCompositionId: 'root',
    assets: [],
    compositions: [
      {
        id: 'root',
        width: 100,
        height: 100,
        duration: 240000,
        frameRate: { numerator: 24, denominator: 1 },
        layers: [
          {
            id: 'box',
            type: 'rect',
            parentId: null,
            start: 0,
            end: 240000,
            width: 10,
            height: 10,
            fill: '#000000',
            transform: identityTransform(),
          },
        ],
        tracks: [],
      },
    ],
  };
  const original = JSON.stringify(source),
    prepared = await prepareAnimation(source),
    player = createControlledAnimationPlayer(prepared, 'root');
  for (const tick of [240000, 120000, 0, 60000, 120000])
    expect(player.sceneAt(tick)).toEqual(evaluateAnimation(prepared, 'root', tick));
  expect(JSON.stringify(source)).toBe(original);
  expect(() => createControlledAnimationPlayer(prepared, 'missing')).toThrow();
});
