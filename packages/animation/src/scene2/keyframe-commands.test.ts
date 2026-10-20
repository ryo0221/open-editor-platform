import { expect, it } from 'vitest';
import {
  createAnimation2,
  createAnimationLayer2,
  evaluateAnimation2,
  prepareAnimation2,
  type Layer2,
} from '@editor-platform/animation-core/v2';
import { addAnimationKeys2 } from './keyframe-commands';

it.each(['group', 'composition'] as const)(
  'inserts the evaluated transform for a non-rendering %s without moving its child',
  (type) => {
    const content = createAnimation2(),
      c = content.compositions[0],
      base = createAnimationLayer2('group', 'parent', c.duration),
      child = createAnimationLayer2('rect', 'child', c.duration);
    const parent: Layer2 =
      type === 'group'
        ? base
        : {
            ...base,
            type: 'composition',
            source: { type: 'local', compositionId: 'nested' },
            time: {
              sourceIn: 0,
              sourceOut: c.duration,
              rate: { numerator: 1, denominator: 1 },
              after: 'hold',
            },
          };
    parent.transform.x = 10;
    c.layers = [parent];
    if (type === 'group') {
      child.parentId = parent.id;
      c.layers.push(child);
    } else
      content.compositions.push({
        ...structuredClone(c),
        id: 'nested',
        layers: [child],
        tracks: [],
      });
    c.tracks = [
      {
        id: 'position',
        layerId: parent.id,
        property: 'x',
        keys: [
          { id: 'start', tick: 0, value: 100, easing: { type: 'linear' } },
          { id: 'end', tick: c.duration, value: 300, easing: { type: 'hold' } },
        ],
      },
    ];
    const tick = c.duration / 2,
      before = evaluateAnimation2(prepareAnimation2(content), c.id, tick),
      result = addAnimationKeys2(content, c.id, [parent.id], 'x', tick, [], {
        canEdit: () => true,
      }),
      next = result.command.apply(content);
    expect(next.compositions[0].tracks[0].keys[1].value).toBe(200);
    expect(evaluateAnimation2(prepareAnimation2(next), c.id, tick).items).toEqual(before.items);
  },
);
