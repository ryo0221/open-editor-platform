import { expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import {
  alignElements,
  appearance,
  createComponent,
  createDesign,
  deleteElements,
  duplicateElements,
  exportDesignSvg,
  groupElements,
  assertDesignContent,
  designContentProblem,
  makeDesignElement,
  insertElement,
  insertInstance,
  transformElements,
  updateComponent,
} from './model';
it('keeps design geometry undoable and duplicates with new identities', () => {
  const s = new EditorSession(createDesign());
  s.execute(insertElement('rectangle'));
  const a = s.content.elements[0];
  s.execute(transformElements([a.id], { dx: 20, dy: 30, dw: 40, dh: 50 }));
  expect(s.content.elements[0].bounds.width).toBe(a.bounds.width + 40);
  s.undo();
  expect(s.content.elements[0]).toEqual(a);
  s.execute(duplicateElements([a.id]));
  expect(s.content.elements).toHaveLength(2);
  expect(s.content.elements[0].id).not.toBe(s.content.elements[1].id);
});
it('shares a component definition across independent instances', () => {
  let d = insertElement('text').apply(createDesign());
  d = createComponent(d.elements[0].id).apply(d);
  const id = d.components[0].id;
  d = insertInstance(id).apply(d);
  d = updateComponent(id, { text: 'Reusable title' }).apply(d);
  expect(d.elements).toHaveLength(2);
  expect(d.elements.map((e) => appearance(d, e).text)).toEqual([
    'Reusable title',
    'Reusable title',
  ]);
  expect(d.elements[0].bounds).not.toEqual(d.elements[1].bounds);
});
it('groups, aligns and deletes nested content without orphan elements', () => {
  let d = insertElement('text').apply(insertElement('rectangle').apply(createDesign()));
  const ids = d.elements.map((e) => e.id);
  d = alignElements(ids, 'left').apply(d);
  expect(d.elements[0].bounds.x).toBe(d.elements[1].bounds.x);
  d = groupElements(ids).apply(d);
  const group = d.elements.find((e) => e.type === 'group')!;
  expect(deleteElements([group.id]).apply(d).elements).toEqual([]);
});
it('escapes ordinary SVG text without leaking model metadata', () => {
  let d = insertElement('text').apply(createDesign());
  d = { ...d, elements: d.elements.map((e) => ({ ...e, text: '<unsafe>& title' })) };
  const svg = exportDesignSvg(d);
  expect(svg).toContain('&lt;unsafe&gt;&amp;');
  expect(svg).not.toContain(d.elements[0].id);
});
it('names the element and field that make Design content invalid', () => {
  const s = new EditorSession(createDesign());
  s.execute(insertElement('text', { id: 'title' }));
  const before = s.content;
  let error: { code?: string; path?: string; message: string } | undefined;
  try {
    s.execute(insertElement('image', { id: 'hero', src: 'https://example.com/car.png' }));
  } catch (e) {
    error = e as typeof error;
  }
  expect(error?.code).toBe('design-content');
  expect(error?.message).toBe(
    'Command produced invalid Design content at elements[1].src (element "hero")',
  );
  expect(error?.path).toBe('elements[1].src (element "hero")');
  expect(s.content).toEqual(before);
  expect(s.content.elements.map((e) => e.id)).toEqual(['title']);

  const text = { ...makeDesignElement('text'), id: 'copy' };
  const cases: [unknown, string | undefined][] = [
    [{ ...createDesign(), elements: [text] }, undefined],
    [null, '$'],
    [{ ...createDesign(), schemaVersion: 4 }, 'schemaVersion'],
    [
      { ...createDesign(), elements: [text, { ...text, opacity: 2 }] },
      'elements[1].id (duplicate element "copy")',
    ],
    [
      { ...createDesign(), elements: [{ ...text, opacity: 2 }] },
      'elements[0].opacity (element "copy")',
    ],
    [
      { ...createDesign(), elements: [{ ...text, bounds: { x: 0 } }] },
      'elements[0].bounds (element "copy")',
    ],
    [
      { ...createDesign(), elements: [{ ...text, parentId: 'gone' }] },
      'elements[0].parentId (element "copy")',
    ],
    [
      {
        ...createDesign(),
        components: [
          {
            id: 'card',
            name: 'Card',
            width: 10,
            height: 10,
            template: text,
            elements: [{ ...text, fill: 1 }],
          },
        ],
      },
      'components[0].elements[0].fill (element "copy")',
    ],
    [
      {
        ...createDesign(),
        components: [{ id: 'card', name: 'Card', width: 0, height: 10, template: text }],
      },
      'components[0].width/height (component "card")',
    ],
  ];
  for (const [value, problem] of cases) {
    expect(designContentProblem(value)).toBe(problem);
    if (problem)
      expect(() => assertDesignContent(value)).toThrow(`invalid Design content at ${problem}`);
  }
});
