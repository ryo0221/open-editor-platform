import { expect, it } from 'vitest';
import { deepFreeze } from '@editor-platform/artifact-core';
import { isDesign, makeDesignElement, type DesignContent } from './model';

function fixture(): DesignContent {
  return {
    schemaVersion: 2,
    elements: [
      { ...makeDesignElement('frame'), id: 'parent' },
      { ...makeDesignElement('text'), id: 'child', parentId: 'parent' },
    ],
    components: [
      {
        id: 'card',
        name: 'Card',
        width: 220,
        height: 160,
        template: { type: 'text', text: 'Default', fill: '#000000' },
        elements: [{ ...makeDesignElement('text'), id: 'body' }],
      },
    ],
  };
}

it('rechecks current hierarchy, duplicate IDs, schema and metadata around unchanged frozen records', () => {
  const d = deepFreeze(fixture());
  expect(isDesign(d)).toBe(true);
  expect(isDesign({ ...d, elements: [d.elements[1]] })).toBe(false);
  expect(isDesign({ ...d, elements: [...d.elements, d.elements[0]] })).toBe(false);
  expect(
    isDesign({ ...d, elements: [{ ...d.elements[0], parentId: 'child' }, d.elements[1]] }),
  ).toBe(false);
  expect(isDesign({ ...d, schemaVersion: 9 })).toBe(false);
  expect(isDesign({ ...d, reuse: { unexpected: true } })).toBe(false);
  expect(
    isDesign({
      ...d,
      components: [{ ...d.components[0], template: { ...d.components[0].template, fill: 9 } }],
    }),
  ).toBe(false);
  expect(
    isDesign({
      ...d,
      components: [
        {
          ...d.components[0],
          elements: [{ ...d.components[0].elements![0], parentId: 'missing' }],
        },
      ],
    }),
  ).toBe(false);
});

it.each([false, true])(
  'revalidates mutable child geometry, overrides and definitions (shallow freeze: %s)',
  (shallow) => {
    const d = fixture();
    d.elements[1].overrides = { label: { bounds: { x: 0, y: 0, width: 10, height: 10 } } };
    if (shallow) {
      Object.freeze(d);
      Object.freeze(d.elements);
      d.elements.forEach(Object.freeze);
      Object.freeze(d.components);
      d.components.forEach(Object.freeze);
    }
    expect(isDesign(d)).toBe(true);
    d.elements[0].bounds.width = -1;
    expect(isDesign(d)).toBe(false);
    d.elements[0].bounds.width = 100;
    expect(isDesign(d)).toBe(true);
    d.elements[1].overrides!.label.bounds!.height = -1;
    expect(isDesign(d)).toBe(false);
    d.elements[1].overrides!.label.bounds!.height = 10;
    d.components[0].elements![0].bounds.x = NaN;
    expect(isDesign(d)).toBe(false);
  },
);
