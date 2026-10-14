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
