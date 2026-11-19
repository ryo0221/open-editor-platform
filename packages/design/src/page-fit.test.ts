import { expect, it } from 'vitest';
import { designPageToFit } from './page-fit';
import { createDesign, insertElement } from './model';
import { insertDesignPage, insertDesignPanel } from './pagination';

function pages() {
  let d = createDesign();
  for (let p = 0; p < 4; p++) {
    const x = p * 650;
    d = insertDesignPage({ x, y: 0, width: 600, height: 800 }, `page-${p}`).apply(d);
    d = insertDesignPanel(
      `page-${p}`,
      { x: x + 20, y: 20, width: 560, height: 350 },
      `panel-${p}`,
    ).apply(d);
    d = insertElement('text', {
      id: `dialogue-${p}`,
      parentId: `panel-${p}`,
      bounds: { x: x + 40, y: 40, width: 400, height: 80 },
    }).apply(d);
  }
  return d;
}
it('Fit page shows the page holding the selection, else the page nearest the viewport centre', () => {
  const d = pages();
  expect(designPageToFit(d, ['dialogue-2'], { x: 0, y: 0 })).toBe('page-2');
  expect(designPageToFit(d, [], { x: 650 * 3 + 300, y: 400 })).toBe('page-3');
  expect(designPageToFit(d, ['missing'], { x: 650 + 10, y: 10 })).toBe('page-1');
  expect(designPageToFit(createDesign(), [], { x: 0, y: 0 })).toBeUndefined();
});
