import { expect, it } from 'vitest';
import {
  createAnimation2,
  createAnimationLayer2,
  evaluateAnimation2,
  prepareAnimation2,
} from '@editor-platform/animation-core/v2';
import { time } from '@editor-platform/video-core';
import { prepareVideoAnimationPin } from './native-pin';

function fixture() {
  const content = createAnimation2();
  content.compositions[0].layers = [createAnimationLayer2('rect', 'box', 960000)];
  content.compositions[0].tracks = [
    {
      id: 'fade',
      layerId: 'box',
      property: 'opacity',
      keys: [
        { id: 'a', tick: 0, value: 0, easing: { type: 'linear' } },
        { id: 'b', tick: 960000, value: 1, easing: { type: 'hold' } },
      ],
    },
  ];
  return content;
}
function source(content: unknown) {
  return {
    artifactId: 'animation',
    versionId: 'v1',
    compositionId: 'root',
    contentHash: prepareAnimation2(content).contentHash,
  };
}
it('matches native poses for exact rational queries and remains pinned after source edits', () => {
  const content = fixture(),
    ref = source(content),
    pin = prepareVideoAnimationPin(ref, content);
  const expected = evaluateAnimation2(prepareAnimation2(content), 'root', 8000);
  expect(pin.sample(time(1, 30))).toEqual(expected);
  expect(pin.sample(time(2)).items[0].opacity).toBe(0.5);
  content.compositions[0].layers[0].transform.x = 900;
  ref.versionId = 'v2';
  expect(pin.sample(time(1, 30))).toEqual(expected);
  expect(pin.source.versionId).toBe('v1');
  expect(Object.isFrozen(pin.snapshot)).toBe(true);
});
it('rejects hash mismatch, missing composition and unsupported schema', () => {
  const content = fixture(),
    ref = source(content);
  expect(() =>
    prepareVideoAnimationPin({ ...ref, contentHash: '0'.repeat(64) }, content),
  ).toThrow();
  expect(() => prepareVideoAnimationPin({ ...ref, compositionId: 'missing' }, content)).toThrow();
  expect(() => prepareVideoAnimationPin(ref, { ...content, schemaVersion: 99 })).toThrow();
});
it('rejects fractional, negative, unsafe and out-of-duration queries without rounding', () => {
  const content = fixture(),
    pin = prepareVideoAnimationPin(source(content), content);
  for (const value of [time(1, 7), time(-1), time(5), time(Number.MAX_SAFE_INTEGER)])
    expect(() => pin.sample(value)).toThrow();
  expect(pin.sample(time(4))).toEqual(
    evaluateAnimation2(prepareAnimation2(content), 'root', 960000),
  );
});
it('rejects unsupported text even when hidden', () => {
  const content = fixture();
  // Text is a valid asset-free domain value; missing image assets also fail native admission.
  const layer = createAnimationLayer2('text', 'unsupported', 960000);
  layer.visible = false;
  content.compositions[0].layers.push(layer);
  expect(() => prepareVideoAnimationPin(source(content), content)).toThrow();
});
it('accepts local composition/path/group and rejects a local cycle', () => {
  const content = fixture();
  const child = {
    ...content.compositions[0],
    id: 'child',
    tracks: [],
    layers: [
      createAnimationLayer2('path', 'path', 960000),
      createAnimationLayer2('group', 'group', 960000),
    ],
  };
  content.compositions.push(child);
  const { type: _kind, ...base } = createAnimationLayer2('group', 'nested', 960000);
  const nested = {
    ...base,
    type: 'composition' as const,
    source: { type: 'local' as const, compositionId: 'child' },
    time: {
      sourceIn: 0,
      sourceOut: 960000,
      rate: { numerator: 1, denominator: 1 },
      after: 'hold' as const,
    },
  };
  content.compositions[0].layers.push(nested);
  const pin = prepareVideoAnimationPin(source(content), content);
  expect(pin.sample(time(1))).toEqual(
    evaluateAnimation2(prepareAnimation2(content), 'root', 240000),
  );
  nested.source.compositionId = 'root';
  expect(() => prepareVideoAnimationPin(pin.source, content)).toThrow();
});

it('refuses public inputs rather than silently applying defaults', () => {
  const content = fixture();
  content.publicInputs = [
    {
      id: 'opacity',
      name: 'Opacity',
      kind: 'number',
      default: 1,
      min: 0,
      max: 1,
      target: { compositionId: 'root', layerId: 'box', property: 'opacity' },
    },
  ];
  content.compositions[0].tracks = [];
  expect(() => prepareVideoAnimationPin(source(content), content)).toThrow('public inputs');
});
