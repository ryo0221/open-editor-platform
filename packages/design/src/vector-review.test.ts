import { expect, it } from 'vitest';
import {
  createDesign,
  createComponent,
  detachInstance,
  isDesign,
  makeDesignElement,
  makeDesignVector,
  designDiff,
  designDrawings,
  type DesignContent,
} from '@editor-platform/design/model';
import { checkVector } from '../../../tests/fixtures/design-reuse/content';

it.each(['text', 'image'] as const)(
  'rejects a vector override on a singleton %s template',
  (type) => {
    const element = { ...makeDesignElement(type), id: 'singleton' };
    const content = createComponent(element.id).apply({ ...createDesign(), elements: [element] });
    content.elements[0].overrides = { root: { vector: checkVector } };
    expect(isDesign(content)).toBe(false);
  },
);
function nestedVector(type: 'shape' | 'text'): DesignContent {
  const instance = {
    ...makeDesignElement('instance'),
    id: 'outer-instance',
    componentId: 'outer',
    overrides: { inner: { overrides: { root: { vector: checkVector } } } },
  };
  return {
    ...createDesign(),
    elements: [instance],
    components: [
      {
        id: 'leaf',
        name: 'Leaf',
        width: 100,
        height: 40,
        template: { type, text: '', fill: 'none' },
      },
      {
        id: 'outer',
        name: 'Outer',
        width: 100,
        height: 40,
        template: { type: 'frame', text: '', fill: 'none' },
        elements: [{ ...makeDesignElement('instance'), id: 'inner', componentId: 'leaf' }],
      },
    ],
  };
}
it('rejects non-shape vector overrides in component-part and nested instance scopes', () => {
  const frame = { ...makeDesignElement('frame'), id: 'frame' };
  const text = { ...makeDesignElement('text'), id: 'label', parentId: 'frame' };
  const content = createComponent(frame.id).apply({ ...createDesign(), elements: [frame, text] });
  content.elements[0].overrides = { label: { vector: checkVector } };
  expect(isDesign(content)).toBe(false);
  expect(isDesign(nestedVector('text'))).toBe(false);
});
it('valid shape overrides remain valid through nested detach and native roundtrip', () => {
  const content = nestedVector('shape');
  expect(isDesign(content)).toBe(true);
  const detached = detachInstance(content.elements[0].id).apply(content);
  expect(isDesign(detached)).toBe(true);
  const inner = detached.elements.find((e) => e.type === 'instance')!;
  const shape = detachInstance(inner.id).apply(detached);
  expect(isDesign(shape)).toBe(true);
  expect(isDesign(JSON.parse(JSON.stringify(shape)))).toBe(true);
  expect(shape.elements.find((e) => e.type === 'shape')!.vector).toEqual(checkVector);
});
it('rejects type overrides that make inherited vector geometry non-shape', () => {
  const icon = { ...makeDesignVector(checkVector), id: 'icon' };
  const content = createComponent(icon.id).apply({ ...createDesign(), elements: [icon] });
  content.elements[0].overrides = { root: { type: 'text' } };
  expect(isDesign(content)).toBe(false);
});
it('requires an actual referenced target for vector overrides without rejecting unrelated legacy fields', () => {
  const element = { ...makeDesignElement('shape'), id: 'icon' };
  const content = createComponent(element.id).apply({ ...createDesign(), elements: [element] });
  content.elements[0].overrides = { missing: { fill: '#abcdef' } };
  expect(isDesign(content)).toBe(true);
  content.elements[0].overrides.missing.vector = checkVector;
  expect(isDesign(content)).toBe(false);
  content.elements[0].componentId = 'missing';
  content.elements[0].overrides = { root: { vector: checkVector } };
  expect(isDesign(content)).toBe(false);
});
it('returns native-valid initial bounds for fractional view boxes without changing vector geometry', () => {
  const vector = {
    ...checkVector,
    viewBox: { x: 0, y: 0, width: 0.5, height: 0.25 },
    paths: ['M0 0L.5 .25'],
  };
  const icon = makeDesignVector(vector);
  expect(isDesign({ ...createDesign(), elements: [icon] })).toBe(true);
  expect(icon.bounds.width).toBeGreaterThanOrEqual(1);
  expect(icon.bounds.height).toBeGreaterThanOrEqual(1);
  expect(icon.vector).toEqual(vector);
});
it.each(['paths', 'viewBox', 'source', 'name', 'version', 'license'] as const)(
  'shows a bounded description of vector %s changes in version comparisons',
  (field) => {
    const icon = { ...makeDesignVector(checkVector), id: 'icon' };
    const before = { ...createDesign(), elements: [icon] };
    const after = structuredClone(before);
    const vector = after.elements[0].vector!;
    if (field === 'paths') vector.paths = ['M0 0L24 24'];
    else if (field === 'viewBox') vector.viewBox.width = 25;
    else vector.provenance[field] = 'Changed';
    const change = designDiff(before, after).changes[0];
    expect(change.before).not.toBe(change.after);
    expect(change.before).toContain('Vector');
    expect(change.after).not.toContain(vector.paths[0]);
  },
);
it('describes geometry changes in singleton component definitions as well as canvas elements', () => {
  const icon = { ...makeDesignVector(checkVector), id: 'icon' };
  const before = createComponent(icon.id).apply({ ...createDesign(), elements: [icon] });
  const after = structuredClone(before);
  after.components[0].template.vector!.paths = ['M0 0L24 24'];
  const change = designDiff(before, after).changes[0];
  expect(change.before).not.toBe(change.after);
  expect(change.before).toContain('Vector');
});

it('does not forward malformed vector values from undeclared style fields into shared drawing primitives', () => {
  const icon = { ...makeDesignElement('shape'), id: 'shape', styleId: 'style' };
  const content = {
    ...createDesign(),
    elements: [icon],
    styles: [{ id: 'style', name: 'Legacy', appearance: { fill: '#abcdef', vector: {} } }],
  };
  expect(isDesign(content)).toBe(true);
  expect(designDrawings(content, icon)[0].vector).toBeUndefined();
});

it('keeps comparison descriptions bounded when vector paths are large', () => {
  const vector = { ...checkVector, paths: Array(5).fill('M0 0' + ' L1 1'.repeat(2000)) };
  const icon = { ...makeDesignVector(vector), id: 'icon' };
  const before = { ...createDesign(), elements: [icon] };
  const after = structuredClone(before);
  after.elements[0].vector!.paths[0] += ' L2 2';
  const change = designDiff(before, after).changes[0];
  expect(change.before!.length).toBeLessThan(2000);
  expect(change.after!.length).toBeLessThan(2000);
  expect(change.before).not.toBe(change.after);
});
