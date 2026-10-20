import { expect, it } from 'vitest';
import { deepFreeze } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  designDrawings,
  overrideInstance,
  parseDesignIntents,
  prepareDesignIntentApplication,
  previewDesignIntents,
  type DesignElement,
  type DesignIntent,
} from './model';
import { nestedTextFixture } from '../../../tests/fixtures/design-nested-text/content';

it('previews and adopts serialized nested and scalar overrides in one native history step', () => {
  const source = deepFreeze(nestedTextFixture());
  const input = [
    { type: 'override', id: 'card', partId: ['section', 'title'], patch: { text: 'Intent title' } },
    { type: 'override', id: 'other', partId: 'section', patch: { fill: '#abcdef' } },
  ];
  const parsed = parseDesignIntents(input);
  input[0].partId = ['missing'];
  const session = new EditorSession(source);
  const preview = previewDesignIntents(source, parsed);
  expect(session.content).toEqual(source);
  const proposal = JSON.parse(JSON.stringify(preview.intentProposal));
  session.execute(prepareDesignIntentApplication(proposal));
  expect(session.content).toEqual(preview.content);
  expect(designDrawings(session.content, session.content.elements[0])[0].text).toBe('Intent title');
  expect(session.content.components).toEqual(source.components);
  expect(session.content.elements[1].overrides?.section.fill).toBe('#abcdef');
  session.undo();
  expect(session.content).toEqual(source);
  expect(session.canUndo).toBe(false);
  session.redo();
  expect(session.content).toEqual(preview.content);
});

it.each([[], Array(17).fill('part'), ['section', 1], ['section', ''], null])(
  'rejects an invalid intent path %j',
  (partId) => {
    expect(() =>
      parseDesignIntents([{ type: 'override', id: 'card', partId, patch: {} }]),
    ).toThrow();
  },
);

it('retains exact opaque path IDs and accepts the 16-ID parser boundary only for overrides', () => {
  const ids = ['section/part', 'a-b', ...Array<string>(14).fill('root')];
  const parsed: DesignIntent[] = parseDesignIntents([
    { type: 'override', id: 'card', partId: ids, patch: { text: 'Exact' } },
  ]);
  expect(parsed[0]).toMatchObject({ partId: ids });
  for (const type of ['update-component-part', 'set-interactions'])
    expect(() =>
      parseDesignIntents([
        type === 'update-component-part'
          ? { type, componentId: 'inner', partId: ['title'], patch: {} }
          : { type, id: 'card', partId: ['section'], interactions: [] },
      ]),
    ).toThrow();
});

it.each([
  { type: 'image' },
  { styleId: 'missing' },
  { parentId: 'missing' },
] satisfies Partial<DesignElement>[])(
  'rejects invalid nested leaf patches atomically, just like direct part edits: %j',
  (patch) => {
    const source = deepFreeze(nestedTextFixture());
    const session = new EditorSession(source);
    const before = session.content;
    const revision = session.revision;
    expect(() => session.execute(overrideInstance('card', ['section', 'title'], patch))).toThrow(
      /immutable|not found|Parent/,
    );
    expect(session.content).toStrictEqual(before);
    expect(session.revision).toEqual(revision);
    expect(session.canUndo).toBe(false);
    const direct = { ...source, elements: [{ ...source.elements[0], componentId: 'inner' }] };
    expect(() => overrideInstance('card', 'title', patch).apply(direct)).toThrow();
  },
);
