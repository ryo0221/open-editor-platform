import { expect, it } from 'vitest';
import { deepFreeze } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { designDrawings, exportDesignSvg, isDesign, overrideInstance } from './model';
import { nestedTextFixture } from '../../../tests/fixtures/design-nested-text/content';

it('keeps direct Inspector/API edits effective after scoped primitive text edits', () => {
  const source = nestedTextFixture();
  delete source.components[0].elements;
  source.components[0].template.text = 'Primitive title';
  source.components[1].elements![0].overrides = {};
  const session = new EditorSession(deepFreeze(source));
  session.execute(
    overrideInstance('card', ['section', 'root'], {
      text: 'Canvas title',
      runs: [{ text: 'Canvas title', style: { bold: true } }],
      fill: '#112233',
      typography: { fontSize: 22, italic: true },
    }),
  );
  const canvas = session.content;
  session.execute(
    overrideInstance('card', 'section', { text: 'Inspector title', runs: undefined }),
  );
  session.execute(overrideInstance('card', 'section', { fill: '#abcdef' }));
  session.execute(overrideInstance('card', 'section', { typography: { fontSize: 24 } }));
  const after = session.content;
  expect(isDesign(after)).toBe(true);
  const drawing = designDrawings(after, after.elements[0])[0];
  expect(drawing).toMatchObject({
    text: 'Inspector title',
    fill: '#abcdef',
    typography: { fontSize: 24, italic: true },
    instanceText: { partIds: ['section', 'root'] },
  });
  expect(drawing.runs).toBeUndefined();
  expect(exportDesignSvg(after, ['card'])).toContain('Inspector title');
  expect(exportDesignSvg(after, ['card'])).not.toContain('Canvas title');
  expect(after.components).toEqual(source.components);
  expect(after.elements[1]).toEqual(source.elements[1]);
  expect(after.elements[0].bounds).toEqual(source.elements[0].bounds);
  for (let i = 0; i < 3; i++) session.undo();
  expect(session.content).toEqual(canvas);
  for (let i = 0; i < 3; i++) session.redo();
  expect(session.content).toEqual(after);
  const roundtrip = JSON.parse(JSON.stringify(after));
  expect(isDesign(roundtrip)).toBe(true);
  expect(designDrawings(roundtrip, roundtrip.elements[0])[0]).toMatchObject({
    text: 'Inspector title',
    fill: '#abcdef',
  });
  const replaced = overrideInstance('card', 'section', { overrides: {} }).apply(after);
  expect(replaced.elements[0].overrides?.section.overrides).toEqual({});
});

it.each([
  ['style', 'locked'],
  ['style', 'hidden'],
  ['root', 'locked'],
  ['root', 'hidden'],
] as const)('does not expose primitive text through an effective %s %s', (owner, flag) => {
  const d = nestedTextFixture();
  delete d.components[0].elements;
  d.components[0].template.text = 'Primitive title';
  d.elements[0].componentId = 'inner';
  const before = designDrawings(d, d.elements[0])[0];
  expect(before.instanceText?.partIds).toEqual(['root']);
  if (owner === 'style') {
    d.styles = [{ id: 'blocked', name: 'Blocked', appearance: { [flag]: true } }];
    d.elements[0].styleId = 'blocked';
  } else d.elements[0].overrides = { root: { [flag]: true } };
  const source = deepFreeze(d);
  const drawings = designDrawings(source, source.elements[0]);
  if (flag === 'hidden') expect(drawings).toEqual([]);
  else {
    expect(drawings[0]).toMatchObject({ locked: true });
    expect(drawings[0].instanceText).toBeUndefined();
  }
  expect(() => overrideInstance('card', ['root'], { text: 'Lost' }).apply(source)).toThrow(
    /Unlock/,
  );
  expect(source).toEqual(d);
});
