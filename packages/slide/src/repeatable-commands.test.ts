import { expect, it } from 'vitest';
import { clone, deepFreeze } from '@editor-platform/artifact-core';
import type { EditorCommand } from '@editor-platform/editor-core';
import {
  addSlide,
  arrangeObjects,
  copiedObjects,
  createDeck,
  groupObjects,
  insertObject,
  insertSlideLayout,
  pasteObjects,
  type SlideContent,
} from './model';

function deckWithTwoShapes(): SlideContent {
  let deck = createDeck();
  deck = insertObject(deck.slides[0].id, 'shape', {
    id: 'a',
    bounds: { x: 100, y: 100, width: 50, height: 50 },
  }).apply(deck);
  deck = insertObject(deck.slides[0].id, 'shape', {
    id: 'b',
    bounds: { x: 300, y: 100, width: 50, height: 50 },
  }).apply(deck);
  return deepFreeze(deck);
}

// Editors apply a command once to check it and again to commit it; shared
// sessions replay and rebase it. Every application must create the same IDs.
it.each<[string, (deck: SlideContent) => EditorCommand<SlideContent>]>([
  ['add slide', () => addSlide()],
  ['add slide layout', () => insertSlideLayout('two-column')],
  ['insert object', (deck) => insertObject(deck.slides[0].id, 'shape')],
  ['group', (deck) => groupObjects(deck.slides[0].id, ['a', 'b'])],
  ['arrange group', (deck) => arrangeObjects(deck.slides[0].id, ['a', 'b'], 'group')],
  ['arrange duplicate', (deck) => arrangeObjects(deck.slides[0].id, ['a', 'b'], 'duplicate')],
  ['paste', (deck) => pasteObjects(deck.slides[0].id, copiedObjects(deck.slides[0], ['a', 'b']))],
])('%s creates the same IDs every time it is applied', (_, make) => {
  const deck = deckWithTwoShapes(),
    command = make(deck);
  const first = command.apply(clone(deck)),
    second = command.apply(clone(deck));
  expect(second).toEqual(first);
  const ids = (d: SlideContent) => d.slides.flatMap((s) => [s.id, ...s.objects.map((o) => o.id)]);
  expect(new Set(ids(first)).size).toBe(ids(first).length);
  expect(ids(first).length).toBeGreaterThan(ids(deck).length);
});

it('pastes a copy offset once and a cut back at its original position', () => {
  const deck = deckWithTwoShapes(),
    page = deck.slides[0];
  const pastedBounds = (clipboard: ReturnType<typeof copiedObjects>) =>
    pasteObjects(page.id, clipboard).apply(deck).slides[0].objects.slice(-1)[0].bounds;
  expect(pastedBounds(copiedObjects(page, ['a']))).toMatchObject({ x: 120, y: 120 });
  expect(pastedBounds(copiedObjects(page, ['a'], 0))).toMatchObject({ x: 100, y: 100 });
  const duplicated = arrangeObjects(page.id, ['a'], 'duplicate').apply(deck);
  expect(duplicated.slides[0].objects.slice(-1)[0].bounds).toMatchObject({ x: 120, y: 120 });
});

it('rejects reapplying a command to its own result instead of duplicating IDs', () => {
  const deck = deckWithTwoShapes(),
    command = arrangeObjects(deck.slides[0].id, ['a', 'b'], 'duplicate');
  expect(() => command.apply(command.apply(clone(deck)))).toThrow(/already applied/);
  const add = addSlide();
  expect(() => add.apply(add.apply(clone(deck)))).toThrow(/already applied/);
});
