import { expect, it } from 'vitest';
import { deepFreeze } from '@editor-platform/artifact-core';
import {
  designDrawings,
  designInstanceElements,
  overrideInstance,
  exportDesignSvg,
  type DesignContent,
} from './model';
import { nestedTextFixture } from '../../../tests/fixtures/design-nested-text/content';
const draw = (d: DesignContent) => designDrawings(d, d.elements[0]);

it('applies styles and style overrides to nested composite instances before projection', () => {
  const d = nestedTextFixture();
  d.styles = [
    { id: 'turn', name: 'Turn', appearance: { rotation: 90 } },
    { id: 'hide', name: 'Hide', appearance: { hidden: true } },
    { id: 'lock', name: 'Lock', appearance: { locked: true } },
  ];
  d.components[1].elements![0].styleId = 'turn';
  expect(designInstanceElements(d, d.elements[0])[0].rotation).toBe(90);
  expect(draw(d).find((x) => x.text === 'Nested title')?.rotation).toBe(90);
  d.elements[0].overrides = { section: { styleId: 'hide' } };
  expect(draw(d)).toEqual([]);
  expect(exportDesignSvg(d, ['card'])).not.toContain('Nested title');
  d.elements[0].overrides = { section: { styleId: 'lock' } };
  expect(draw(d).find((x) => x.text === 'Nested title')?.instanceText).toBeUndefined();
  expect(() =>
    overrideInstance('card', ['section', 'title'], { text: 'Lost' }).apply(deepFreeze(d)),
  ).toThrow(/Unlock/);
});

it.each(['hidden', 'locked'] as const)(
  'edits the addressed path despite an unrelated %s descendant',
  (flag) => {
    const d = nestedTextFixture();
    const section = d.components[1].elements![0];
    d.components[1].elements!.push({
      ...d.components[0].elements![1],
      id: 'unrelated',
      parentId: section.id,
      [flag]: true,
    });
    const before = deepFreeze(d);
    const after = overrideInstance('card', ['section', 'title'], { text: 'Visible label' }).apply(
      before,
    );
    expect(draw(after).some((x) => x.text === 'Visible label')).toBe(true);
    expect(after.components).toEqual(before.components);
    expect(after.elements[1]).toEqual(before.elements[1]);
  },
);

it('keeps legacy direct primitive overrides, then prioritizes explicit scoped root text', () => {
  let d = nestedTextFixture();
  delete d.components[0].elements;
  d.components[0].template = {
    type: 'text',
    text: 'Default',
    fill: '#112233',
    typography: { fontSize: 18 },
  };
  d.components[1].elements![0].overrides = { root: { text: 'Definition root', fill: '#334455' } };
  d = overrideInstance('card', 'section', {
    text: 'Legacy',
    fill: '#ff00ff',
    typography: { fontSize: 22 },
    runs: [{ text: 'Legacy', style: { bold: true } }],
  }).apply(d);
  const legacy = draw(d).find((x) => x.text === 'Legacy')!;
  expect(legacy).toMatchObject({
    fill: '#ff00ff',
    typography: { fontSize: 22 },
    runs: [{ text: 'Legacy', style: { bold: true } }],
    bounds: { x: 50, y: 50 },
    instanceText: { partIds: ['section', 'root'] },
  });
  expect(legacy.textSourcePath).toEqual(['elements', 0, 'overrides', 'section', 'text']);
  expect(exportDesignSvg(d, ['card'])).toContain('Legacy');
  expect(designDrawings(d, d.elements[1]).some((x) => x.text === 'Definition root')).toBe(true);
  d = overrideInstance('card', ['section', 'root'], { text: 'Scoped', runs: undefined }).apply(d);
  const scoped = draw(d).find((x) => x.text === 'Scoped')!;
  expect(scoped).toMatchObject({
    fill: '#ff00ff',
    typography: { fontSize: 22 },
    bounds: legacy.bounds,
  });
  expect(scoped.textSourcePath).toEqual([
    'elements',
    0,
    'overrides',
    'section',
    'overrides',
    'root',
    'text',
  ]);
  expect(exportDesignSvg(d, ['card'])).toContain('Scoped');
});
