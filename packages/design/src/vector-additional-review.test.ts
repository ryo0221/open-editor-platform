import { expect, it } from 'vitest';
import { drawingSvg } from '@editor-platform/editor-core';
import {
  appearance,
  createComponent,
  createDesign,
  designDrawings,
  detachInstance,
  isDesign,
  makeDesignElement,
  makeDesignVector,
  validDesignVector,
  type DesignElement,
} from '@editor-platform/design/model';
import { checkVector } from '../../../tests/fixtures/design-reuse/content';

it.each([0, 1, 2, 3, 5])('keeps normal indexed placement for vector index %s', (index) => {
  const base = makeDesignElement('shape', index);
  expect(makeDesignVector(checkVector, index).bounds).toEqual({
    ...base.bounds,
    width: 24,
    height: 24,
  });
});

it.each(['empty', 'mixed', 'inherited'])(
  'rejects %s sparse paths before constructor, native validation and JSON serialization',
  (kind) => {
    const paths = new Array<string>(kind === 'mixed' ? 2 : 1);
    if (kind === 'mixed') paths[0] = 'M0 0L24 24';
    if (kind === 'inherited')
      Object.setPrototypeOf(paths, { 0: 'M0 0', __proto__: Array.prototype });
    const vector = { ...checkVector, paths };
    expect(validDesignVector(vector)).toBe(false);
    expect(() => makeDesignVector(vector)).toThrow(/Invalid/);
    const icon = { ...makeDesignElement('shape'), vector };
    expect(isDesign({ ...createDesign(), elements: [icon] })).toBe(false);
    expect(validDesignVector(JSON.parse(JSON.stringify(vector)))).toBe(kind === 'inherited');
  },
);

it.each([false, true])('ignores valid style vector geometry on a native vector=%s', (hasVector) => {
  const element = {
    ...(hasVector ? makeDesignVector(checkVector) : makeDesignElement('shape')),
    id: 'shape',
    styleId: 'style',
  };
  const content = {
    ...createDesign(),
    elements: [element],
    styles: [
      {
        id: 'style',
        name: 'Imported',
        appearance: { stroke: '#abcdef', vector: { ...checkVector, paths: ['M0 0L24 24'] } },
      },
    ],
  };
  const before = JSON.stringify(content);
  expect(isDesign(content)).toBe(true);
  expect(appearance(content, element).vector).toEqual(element.vector);
  expect(designDrawings(content, element)[0]).toMatchObject({ stroke: '#abcdef' });
  expect(designDrawings(content, element)[0].vector).toEqual(element.vector);
  const singleton = createComponent(element.id).apply(content);
  expect(isDesign(singleton)).toBe(true);
  expect(designDrawings(singleton, singleton.elements[0])[0].vector).toEqual(element.vector);
  expect(detachInstance(singleton.elements[0].id).apply(singleton).elements[0].vector).toEqual(
    element.vector,
  );
  expect(JSON.stringify(content)).toBe(before);
});

it('keeps native vector overrides ahead of styles in composite and nested parts', () => {
  const override = { ...checkVector, paths: ['M1 1L23 23'] };
  const part = { ...makeDesignVector(checkVector), id: 'icon', styleId: 'style' };
  const inner: DesignElement = {
    ...makeDesignElement('instance'),
    id: 'inner',
    componentId: 'icons',
    overrides: { icon: { vector: override } },
  };
  const outer = { ...makeDesignElement('instance'), id: 'outer', componentId: 'nested' };
  const content = {
    ...createDesign(),
    elements: [outer],
    styles: [
      { id: 'style', name: 'Imported', appearance: { fill: '#abcdef', vector: checkVector } },
    ],
    components: [
      {
        id: 'icons',
        name: 'Icons',
        width: 200,
        height: 150,
        template: { type: 'frame' as const, text: '', fill: 'none' },
        elements: [part],
      },
      {
        id: 'nested',
        name: 'Nested',
        width: 200,
        height: 150,
        template: { type: 'frame' as const, text: '', fill: 'none' },
        elements: [inner],
      },
    ],
  };
  expect(isDesign(content)).toBe(true);
  expect(designDrawings(content, outer)[0]).toMatchObject({ vector: override, fill: '#abcdef' });
  delete inner.overrides!.icon.vector;
  expect(designDrawings(content, outer)[0].vector).toEqual(part.vector);
});

it('clips transformed vector paths to the original nonzero view box', () => {
  const vector = {
    ...checkVector,
    viewBox: { x: 10, y: 20, width: 24, height: 12 },
    paths: ['M-100 -100H1000000V1000000H-100Z'],
  };
  const icon = { ...makeDesignVector(vector), rotation: 30, flipX: true };
  const drawing = designDrawings({ ...createDesign(), elements: [icon] }, icon)[0];
  const svg = drawingSvg([drawing, { ...drawing, id: 'other' }], {
    x: 0,
    y: 0,
    width: 200,
    height: 150,
  });
  expect(svg).toContain('clipPath id="vector-graphic-0" clipPathUnits="userSpaceOnUse"');
  expect(svg).toContain('rect x="10" y="20" width="24" height="12"');
  expect(svg).toContain('clip-path="url(#vector-graphic-0)"');
  expect(svg).toContain('clip-path="url(#vector-graphic-1)"');
  expect(svg).toContain('rotate(30) scale(-1 1)');
});
