import { expect, it } from 'vitest';
import { deepFreeze } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  designDrawings,
  exportDesignSvg,
  isDesign,
  overrideInstance,
  type DesignContent,
} from './model';
import { nestedTextFixture } from '../../../tests/fixtures/design-nested-text/content';

const drawings = (d: DesignContent, id = 'card') =>
  designDrawings(d, d.elements.find((e) => e.id === id)!);
it('edits an instance-local nested label without losing inherited sibling overrides or history', () => {
  const source = deepFreeze(nestedTextFixture());
  const path = ['section', 'title'];
  const patch = { text: 'Edited title', runs: [{ text: 'Edited title', style: { bold: true } }] };
  const edit = overrideInstance('card', path, patch);
  path[0] = 'missing';
  patch.text = 'mutated';
  patch.runs[0].style.bold = false;
  const session = new EditorSession(source);
  session.execute(edit);
  const after = session.content;
  expect(isDesign(after)).toBe(true);
  expect(drawings(after).find((e) => e.text === 'Edited title')?.runs).toEqual([
    { text: 'Edited title', style: { bold: true } },
  ]);
  expect(drawings(after).find((e) => e.text === 'Retained body')?.typography?.bold).toBe(true);
  expect(drawings(after, 'other')).toEqual(drawings(source, 'other'));
  expect(after.components).toEqual(source.components);
  expect(drawings(after).find((e) => e.text === 'Edited title')?.instanceText).toEqual({
    elementId: 'card',
    partIds: ['section', 'title'],
    name: 'title',
  });
  const roundTrip = JSON.parse(JSON.stringify(after));
  expect(isDesign(roundTrip)).toBe(true);
  expect(drawings(roundTrip)).toEqual(drawings(after));
  expect(exportDesignSvg(after)).toContain('Edited title');
  expect(exportDesignSvg(after)).not.toContain('instanceText');
  session.undo();
  expect(session.content).toEqual(source);
  session.redo();
  expect(session.content).toEqual(after);
});

it('supports the native 16-part boundary without exposing deeper text targets', () => {
  const d = nestedTextFixture();
  const leaf = d.components[0].elements![0];
  d.elements = [{ ...d.elements[0], componentId: 'level-0' }];
  d.components = Array.from({ length: 16 }, (_, i) => ({
    id: `level-${i}`,
    name: `Level ${i}`,
    width: 240,
    height: 160,
    template: { type: 'text' as const, text: '', fill: '#000000' },
    elements: [
      {
        ...leaf,
        id: 'part',
        ...(i < 15 ? { type: 'instance' as const, componentId: `level-${i + 1}` } : {}),
      },
    ],
  }));
  const path = Array<string>(16).fill('part');
  const after = overrideInstance('card', path, { text: 'Deep title' }).apply(d);
  expect(drawings(after).find((e) => e.text === 'Deep title')?.instanceText?.partIds).toEqual(path);
  d.components.unshift({
    ...d.components[0],
    id: 'deeper',
    elements: [{ ...d.components[0].elements![0], componentId: 'level-0' }],
  });
  d.elements[0].componentId = 'deeper';
  expect(drawings(d).find((e) => e.text === leaf.text)?.instanceText).toBeUndefined();
});

it.each(['root', 'instance', 'part', 'ancestor'])(
  'rejects edits through a locked %s without changing content',
  (locked) => {
    const d = nestedTextFixture();
    if (locked === 'root') d.elements[0].locked = true;
    if (locked === 'instance') d.components[1].elements![0].locked = true;
    if (locked === 'part') d.components[0].elements![0].locked = true;
    if (locked === 'ancestor') {
      const parent = {
        ...d.components[0].elements![1],
        id: 'frame',
        type: 'frame' as const,
        locked: true,
      };
      d.components[0].elements![0].parentId = parent.id;
      d.components[0].elements!.push(parent);
    }
    const source = deepFreeze(d);
    expect(drawings(source).find((e) => e.text === 'Nested title')?.instanceText).toBeUndefined();
    expect(() =>
      overrideInstance('card', ['section', 'title'], { text: 'Lost' }).apply(source),
    ).toThrow(/Unlock/);
    expect(source).toEqual(d);
  },
);

it('uses exact opaque part paths even when nested drawing IDs collide', () => {
  const d = nestedTextFixture();
  d.components[1].elements![0].id = 'a-b';
  d.components[0].elements![0].id = 'c';
  d.components[1].elements!.push({ ...d.components[0].elements![0], id: 'a-b-c', text: 'Sibling' });
  expect(drawings(d).filter((e) => e.id === 'card-a-b-c')).toHaveLength(2);
  const after = overrideInstance('card', ['a-b', 'c'], { text: 'Exact path' }).apply(d);
  expect(
    drawings(after)
      .filter((e) => e.id === 'card-a-b-c')
      .map((e) => [e.text, e.instanceText?.partIds]),
  ).toEqual([
    ['Exact path', ['a-b', 'c']],
    ['Sibling', ['a-b-c']],
  ]);
  d.components[1].elements![0].id = 'section/part';
  expect(() =>
    overrideInstance('card', ['section/part', 'c'], { text: 'Slash preserved' }).apply(d),
  ).not.toThrow();
});

it('supports template-only root parts and rejects missing, overlong and non-instance paths atomically', () => {
  const d = nestedTextFixture();
  delete d.components[0].elements;
  d.components[1].elements![0].overrides = {};
  d.components[0].template.text = 'Legacy label';
  const after = overrideInstance('card', ['section', 'root'], { text: 'Legacy edited' }).apply(d);
  expect(drawings(after).find((e) => e.text === 'Legacy edited')?.instanceText?.partIds).toEqual([
    'section',
    'root',
  ]);
  for (const path of [
    [],
    ['missing'],
    ['section', 'missing'],
    ['section', 'root', 'bad'],
    Array(17).fill('section'),
  ])
    expect(() => overrideInstance('card', path, { text: 'Lost' }).apply(deepFreeze(d))).toThrow();
  expect(drawings(d).some((e) => e.text === 'Legacy label')).toBe(true);
});
