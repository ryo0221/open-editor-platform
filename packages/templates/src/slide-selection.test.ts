import { expect, it } from 'vitest';
import { clone, deepFreeze } from '@editor-platform/artifact-core';
import { createDeck, makeSlideObject, isDeck } from '@editor-platform/slide/model';
import { authorReusableComponent, saveAsTemplate } from './index';

function fixture() {
  const deck = createDeck();
  deck.slides = ['first', 'second'].map((id) => ({
    id,
    title: id,
    background: '#ffffff',
    objects: [
      { ...makeSlideObject('group', 0), id: `${id}-group` },
      { ...makeSlideObject('text', 1), id: `${id}-text`, groupId: `${id}-group` },
      { ...makeSlideObject('text', 2), id: 'unselected' },
    ],
  }));
  return deck;
}
const selection = {
  ids: ['first-group', 'second-group'],
  slideSelection: [
    { pageId: 'first', elementId: 'first-group' },
    { pageId: 'second', elementId: 'second-group' },
  ],
};
const authors = {
  template: (content: ReturnType<typeof fixture>) =>
    saveAsTemplate({
      domain: 'slide',
      content,
      ...selection,
      name: 'Two-page fragment',
      purpose: 'Scoped capture',
      category: 'Tests',
      kind: 'fragment',
      slots: [],
    }),
  reusable: (content: ReturnType<typeof fixture>) =>
    authorReusableComponent({
      domain: 'slide',
      content,
      ...selection,
      name: 'Two-page component',
      slide: 'pages',
    }),
};

for (const [kind, author] of Object.entries(authors)) {
  it(`${kind}: captures multi-page group closure despite unselected page-local duplicate IDs`, async () => {
    const source = deepFreeze(fixture());
    const before = clone(source);
    expect(isDeck(source)).toBe(true);
    const saved = await author(source);
    const text = JSON.stringify(saved);
    expect(text).not.toContain('unselected');
    for (const id of ['first-group', 'first-text', 'second-group', 'second-text'])
      expect(text).toContain(id);
    expect(source).toEqual(before);
  });

  it(`${kind}: still rejects duplicate IDs inside the published selection`, async () => {
    const source = fixture();
    source.slides[0].objects[1].id = 'selected-child';
    source.slides[1].objects[1].id = 'selected-child';
    expect(isDeck(source)).toBe(true);
    await expect(author(source)).rejects.toThrow('Duplicate native IDs');
  });

  it(`${kind}: validates the native source before removing unselected records`, async () => {
    const source = fixture();
    source.slides[0].objects[2].groupId = 'missing-parent';
    expect(isDeck(source)).toBe(false);
    await expect(author(source)).rejects.toThrow('Invalid slide native content');
  });
}
