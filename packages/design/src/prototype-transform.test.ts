import { expect, it } from 'vitest';
import { deepFreeze } from '@editor-platform/artifact-core';
import { designDrawings, designInstanceElements } from './model';
import { designPrototypeAddress, designPrototypeTargets } from './prototype';
import { prototypeFixture } from '../../../tests/fixtures/design-prototype/content';

it.each([{ rotation: 90 }, { flipX: true }, { flipY: true }, { rotation: 90, flipX: true }])(
  'shares composite style transforms across drawings, hotspots and annotation bounds: %j',
  (transform) => {
    const d = prototypeFixture();
    const instance = d.elements.find((e) => e.id === 'next/instance')!;
    d.components[0].elements![1].bounds = { x: 10, y: 5, width: 90, height: 30 };
    instance.styleId = 'transform';
    d.styles = [{ id: 'transform', name: 'Transform', appearance: transform }];
    const direct = structuredClone(d);
    Object.assign(direct.elements.find((e) => e.id === instance.id)!, transform, {
      styleId: undefined,
    });
    const source = deepFreeze(d);
    expect(designInstanceElements(source, instance)).toEqual(
      designInstanceElements(direct, direct.elements.find((e) => e.id === instance.id)!),
    );
    const target = designPrototypeTargets(source, 'Home').find((e) => e.name === 'Continue')!;
    const drawing = designDrawings(source, instance).find((e) => e.text === 'Continue')!;
    expect(target.bounds).toEqual(drawing.bounds);
    expect(target.rotation).toBe(drawing.rotation ?? 0);
    expect(designPrototypeAddress('artifact', target).region).toEqual({
      type: 'canvas',
      ...drawing.bounds,
    });
  },
);
