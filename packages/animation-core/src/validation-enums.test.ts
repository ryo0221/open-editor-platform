import { describe, expect, it } from 'vitest';
import { animationFixture } from './fixtures';
import {
  evaluateAnimation,
  identityTransform,
  prepareAnimation,
  validateAnimation,
  type Easing,
  type TimeMapping,
} from './index';

function nestedFixture(easing: Easing = { type: 'linear' }, after: TimeMapping['after'] = 'loop') {
  const content = animationFixture();
  const child = content.compositions[0];
  child.id = 'child';
  child.tracks[0].keys[0].easing = easing;
  content.compositions.unshift({
    id: 'root',
    width: 640,
    height: 360,
    duration: 240000,
    frameRate: { numerator: 24, denominator: 1 },
    tracks: [],
    layers: [
      {
        id: 'frame',
        type: 'group',
        parentId: null,
        start: 0,
        end: 240000,
        transform: identityTransform(),
      },
      {
        id: 'nested',
        type: 'composition',
        parentId: 'frame',
        start: 0,
        end: 240000,
        transform: identityTransform(),
        source: { type: 'local', compositionId: 'child' },
        time: { sourceIn: 0, sourceOut: 120000, rate: { numerator: 1, denominator: 1 }, after },
      },
    ],
  });
  return content;
}

const cases = [
  {
    field: 'layer.type',
    values: ['rect', 'group', 'composition'],
    code: 'unsupported-layer',
    target: (c: ReturnType<typeof nestedFixture>) => c.compositions[0].layers[0],
    key: 'type',
  },
  {
    field: 'time.after',
    values: ['hold', 'loop', 'hide'],
    code: 'after',
    target: (c: ReturnType<typeof nestedFixture>) => {
      const layer = c.compositions[0].layers[1];
      if (layer.type !== 'composition') throw new Error('fixture');
      return layer.time;
    },
    key: 'after',
  },
  {
    field: 'easing.type',
    values: ['hold', 'linear', 'bezier'],
    code: 'easing',
    target: (c: ReturnType<typeof nestedFixture>) => c.compositions[1].tracks[0].keys[0].easing,
    key: 'type',
  },
];
for (const entry of cases) {
  describe(`strict JSON enum ${entry.field}`, () => {
    for (const value of [...entry.values.map((v) => [v]), 0, {}, null, true, 'unknown']) {
      it(`rejects ${JSON.stringify(value)} before preparation/evaluation`, async () => {
        const content = nestedFixture();
        Object.assign(entry.target(content), { [entry.key]: value });
        const json: unknown = JSON.parse(JSON.stringify(content));
        expect(() => validateAnimation(json)).toThrow(entry.code);
        await expect(prepareAnimation(json)).rejects.toThrow(entry.code);
      });
    }
  });
}

for (const easing of [
  { type: 'hold' },
  { type: 'linear' },
  { type: 'bezier', x1: 0, y1: 0, x2: 1, y2: 1 },
] satisfies Easing[]) {
  for (const after of ['hold', 'loop', 'hide'] as const) {
    it(`validated ${easing.type}/${after} JSON agrees with evaluator and returns finite scene values`, async () => {
      const source = nestedFixture(easing, after);
      const validated = validateAnimation(JSON.parse(JSON.stringify(source)));
      expect(validated).toEqual(source);
      const original = await prepareAnimation(source);
      const prepared = await prepareAnimation(validated);
      for (const tick of [0, 60000, 119999, 120000, 240000, 60000]) {
        const scene = evaluateAnimation(prepared, 'root', tick);
        expect(scene).toEqual(evaluateAnimation(original, 'root', tick));
        expect(scene.rectangles).toHaveLength(after === 'hide' && tick >= 120000 ? 0 : 1);
        for (const rectangle of scene.rectangles) {
          expect(rectangle.layerId).toBe('box');
          expect([...rectangle.matrix, rectangle.opacity].every(Number.isFinite)).toBe(true);
        }
      }
    });
  }
}
