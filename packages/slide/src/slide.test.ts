import { expect, it } from 'vitest';
import { commitVersion, createArtifact } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  addSlide,
  createDeck,
  duplicateSlide,
  exportSlideSvg,
  insertObject,
  reorderSlide,
  resizeDeck,
  slideDiff,
  transformObjects,
  makeSlideObject,
} from './model';
it('compares individual slide objects with readable geometry and no embedded image bytes', () => {
  const before = createDeck(),
    image = { ...makeSlideObject('image', 0), src: 'data:image/png;base64,AAAA', alt: '写真' };
  before.slides[0].objects = [image];
  const after = structuredClone(before);
  after.slides[0].objects[0].bounds.x += 20;
  const changes = slideDiff(before, after).changes;
  expect(changes).toHaveLength(1);
  expect(changes[0].path).toContain('/ image');
  expect(changes[0].before).toContain('Image: 写真');
  expect(changes[0].after).toContain(`Position: ${image.bounds.x + 20},`);
  expect(changes[0].before).not.toContain('base64');
});
it('reorders slides without changing identities and supports undo', () => {
  const s = new EditorSession(createDeck());
  s.execute(addSlide());
  s.execute(addSlide());
  const ids = s.content.slides.map((slide) => slide.id);
  const pages = structuredClone(s.content.slides);
  s.execute(resizeDeck(960, 720));
  expect(s.content.slides).toEqual(pages);
  expect(() => resizeDeck(0, 720).apply(s.content)).toThrow('dimensions');
  s.execute(reorderSlide(ids[2], -1));
  expect(s.content.slides.map((slide) => slide.id)).toEqual([ids[0], ids[2], ids[1]]);
  expect(s.content.slides).toEqual([pages[0], pages[2], pages[1]]);
  expect(s.undo().slides.map((slide) => slide.id)).toEqual(ids);
});
it('versions independent deck and object content immutably', async () => {
  const d = createDeck();
  const a = await commitVersion(createArtifact('slide', 'Deck', d), 'actor', 'First');
  const next = insertObject(d.slides[0].id, 'chart').apply(d);
  expect(a.versions[0].content.slides[0].objects).toHaveLength(0);
  expect(slideDiff(d, next).changes).toHaveLength(1);
  const chart = next.slides[0].objects[0];
  const moved = transformObjects(d.slides[0].id, [chart.id], {
    dx: 20,
    dy: 10,
    dw: 40,
    dh: 0,
  }).apply(next);
  expect(moved.slides[0].objects[0].bounds.width).toBe(chart.bounds.width + 40);
});
it('duplicates with fresh object IDs and produces a standalone slide image', () => {
  const blank = createDeck();
  const d = insertObject(blank.slides[0].id, 'text', { text: 'Ideas worth sharing' }).apply(blank),
    copy = duplicateSlide(d.slides[0].id).apply(d);
  expect(copy.slides[1].id).not.toBe(copy.slides[0].id);
  expect(copy.slides[1].objects[0].id).not.toBe(copy.slides[0].objects[0].id);
  const svg = exportSlideSvg(d, d.slides[0]);
  expect(svg).toContain('Ideas worth sharing');
  expect(svg).not.toContain(d.slides[0].id);
});
it('duplicates adjacent to its source with stable preview IDs and one undo', () => {
  const deck = addSlide().apply(createDeck());
  const source = deck.slides[0];
  source.objects = [makeSlideObject('group', 0), makeSlideObject('text', 1)];
  source.objects[1].groupId = source.objects[0].id;
  const session = new EditorSession(deck);
  const command = duplicateSlide(source.id, 'selected-copy');
  const preview = command.apply(session.content);
  session.execute(command);
  expect(session.content).toEqual(preview);
  expect(session.content.slides.map((s) => s.id)).toEqual([
    source.id,
    'selected-copy',
    deck.slides[1].id,
  ]);
  const copy = session.content.slides[1];
  expect(copy.objects[1].groupId).toBe(copy.objects[0].id);
  expect(copy.objects[0].id).not.toBe(source.objects[0].id);
  expect(session.undo()).toEqual(deck);
  expect(session.redo()).toEqual(preview);
});
