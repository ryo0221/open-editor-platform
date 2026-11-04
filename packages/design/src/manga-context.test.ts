import { expect, it } from 'vitest';
import { createDesign, insertElement, deleteElements } from './model';
import { insertDesignPage, insertDesignPanel } from './pagination';
import { mangaEditingContext } from './manga-context';

it('follows nested artwork to its panel and keeps a cleared selection on the current page', () => {
  let d = createDesign();
  for (const [i, id] of ['first', 'second'].entries()) {
    d = insertDesignPage({ x: i * 700, y: 0, width: 600, height: 800 }, id).apply(d);
    d = insertDesignPanel(
      id,
      { x: i * 700 + 30, y: 30, width: 540, height: 350 },
      `${id}-panel`,
    ).apply(d);
  }
  d = insertDesignPanel(
    'second',
    { x: 730, y: 400, width: 540, height: 350 },
    'second-later',
  ).apply(d);
  d = insertElement('group', { id: 'balloon', parentId: 'second-later' }).apply(d);
  d = insertElement('text', { id: 'dialogue', parentId: 'balloon' }).apply(d);
  const selected = mangaEditingContext(d, ['dialogue'], 'first');
  expect(selected.page?.frameId).toBe('second');
  expect(selected.panel?.id).toBe('second-later');
  expect(mangaEditingContext(d, [], 'second').panel?.id).toBe('second-panel');
  expect(mangaEditingContext(d, ['deleted-dialogue'], 'second').page?.frameId).toBe('second');
  expect(mangaEditingContext(deleteElements(['second']).apply(d), [], 'second').page?.frameId).toBe(
    'first',
  );
});

it('uses the page when no panel exists and provides no owner for unpaginated Design', () => {
  const blank = createDesign();
  expect(mangaEditingContext(blank, []).frame).toBeUndefined();
  const paginated = insertDesignPage({ x: 0, y: 0, width: 600, height: 800 }, 'page').apply(blank);
  const target = mangaEditingContext(paginated, []);
  expect(target.frame?.id).toBe('page');
  expect(target.panel).toBeUndefined();
});
