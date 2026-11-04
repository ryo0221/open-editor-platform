import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DocumentBlock } from './model';
import { DocumentPrintRenderer } from './print-renderer';

/** Records where text and 傍点 are painted; every character is one em wide. */
let painted: {
  kind: 'text' | 'dot' | 'rect' | 'fill';
  text: string;
  x: number;
  y: number;
  size: number;
  page: number;
}[];
let page: number;
beforeEach(() => {
  painted = [];
  page = -1;
  const ctx = {
    font: '16px system-ui',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    size() {
      return Number(/(\d+(?:\.\d+)?)px/.exec(this.font)![1]);
    },
    scale() {},
    fillRect(x: number, y: number, _width: number, height: number) {
      painted.push({ kind: 'fill', text: '', x, y, size: height, page });
    },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fill() {},
    save() {},
    restore() {},
    clip() {},
    rect() {},
    strokeRect(x: number, y: number) {
      painted.push({ kind: 'rect', text: '', x, y, size: 0, page });
    },
    measureText(text: string) {
      return { width: [...text].length * this.size() };
    },
    fillText(text: string, x: number, y: number) {
      painted.push({ kind: 'text', text, x, y, size: this.size(), page });
    },
    arc(x: number, y: number, r: number) {
      painted.push({ kind: 'dot', text: '', x, y, size: r, page });
    },
  };
  vi.stubGlobal('document', {
    createElement: () => {
      page++;
      return { width: 0, height: 0, getContext: () => ctx };
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const ruby = { text: 'とうきょう', base: '東京' };
it('keeps 傍点 under one list item clear of the next item’s reading', async () => {
  const list: DocumentBlock = {
    id: 'l',
    type: 'bulleted-list',
    text: '',
    items: ['a', 'b'].map((id) => ({
      id,
      text: '東京',
      rich: [{ text: '東京', ruby, emphasisDots: true }],
    })),
  };
  const renderer = new DocumentPrintRenderer(794, 1123, 64);
  await renderer.block([list], 0);
  const dots = painted.filter((p) => p.kind === 'dot');
  const readings = painted.filter((p) => p.text === 'とうきょう');
  expect(readings).toHaveLength(2);
  // The first item's dots end above where the second item's 8px reading starts (ascent 0.88em).
  const firstDotsBottom = Math.max(...dots.slice(0, 2).map((d) => d.y + d.size));
  expect(firstDotsBottom).toBeLessThanOrEqual(readings[1].y - 8 * 0.88 + 0.01);
});

it('keeps a first-line reading on the page with a large font and a small margin', async () => {
  const paragraph: DocumentBlock = {
    id: 'p',
    type: 'paragraph',
    text: '東京',
    style: { fontSize: 108 },
    rich: [{ text: '東京', ruby }],
  };
  const renderer = new DocumentPrintRenderer(794, 1123, 24);
  await renderer.block([paragraph], 0);
  const reading = painted.find((p) => p.text === 'とうきょう')!;
  // The reading's 72px glyphs (ascent 0.88em) start below the top edge of the canvas.
  expect(reading.y - reading.size * 0.88).toBeGreaterThanOrEqual(-0.01);
});

it('starts a new page when a line’s 傍点 would fall off the bottom of this one', async () => {
  const paragraph: DocumentBlock = {
    id: 'p',
    type: 'paragraph',
    text: '東京',
    // 144px text at line height 1, starting at y ≈ 948.8: its height fits but not its dots.
    style: { fontSize: 108, lineHeight: 1, spaceBefore: (924.8 * 3) / 4 },
    rich: [{ text: '東京', ruby, emphasisDots: true }],
  };
  const renderer = new DocumentPrintRenderer(794, 1123, 24);
  await renderer.block([paragraph], 0);
  for (const dot of painted.filter((p) => p.kind === 'dot'))
    expect(dot.y + dot.size).toBeLessThanOrEqual(1123);
});

it('keeps a reading clear of the table before it', async () => {
  const blocks: DocumentBlock[] = [
    { id: 't', type: 'table', text: '', cells: [['表']] },
    {
      id: 'p',
      type: 'paragraph',
      text: '東京',
      style: { fontSize: 108, spaceBefore: 0 },
      rich: [{ text: '東京', ruby }],
    },
  ];
  const renderer = new DocumentPrintRenderer(794, 1123, 24);
  await renderer.block(blocks, 0);
  const tableBottom = (renderer as unknown as { y: number }).y - 10;
  await renderer.block(blocks, 1);
  const reading = painted.find((p) => p.text === 'とうきょう')!;
  expect(reading.y - reading.size * 0.88).toBeGreaterThanOrEqual(tableBottom - 0.01);
});

it('keeps a heading with the ruby paragraph after it, measured with the heading’s own ink', async () => {
  const blocks: DocumentBlock[] = [
    {
      id: 'h',
      type: 'heading',
      level: 2,
      text: '見出し',
      style: { fontSize: 25.5, lineHeight: 1, spaceAfter: 0 },
    },
    {
      id: 'p',
      type: 'paragraph',
      text: '東京',
      style: { lineHeight: 1, spaceAfter: 0 },
      rich: [{ text: '東京', ruby }],
    },
  ];
  const renderer = new DocumentPrintRenderer(794, 1123, 24);
  // As if earlier content ended here: the pair does not fit, but fits on a fresh page.
  (renderer as unknown as { y: number }).y = 1037.47;
  await renderer.block(blocks, 0);
  await renderer.block(blocks, 1);
  const heading = painted.find((p) => p.text === '見')!;
  const body = painted.find((p) => p.text === '東')!;
  expect(heading.page).toBe(body.page);
});

it('starts a table below 傍点 hanging from the paragraph before it', async () => {
  const blocks: DocumentBlock[] = [
    {
      id: 'p',
      type: 'paragraph',
      text: '東京',
      style: { fontSize: 108, lineHeight: 1.2 },
      rich: [{ text: '東京', ruby, emphasisDots: true }],
    },
    { id: 't', type: 'table', text: '', cells: [['表']] },
  ];
  const renderer = new DocumentPrintRenderer(794, 1123, 24);
  await renderer.block(blocks, 0);
  await renderer.block(blocks, 1);
  const dotsBottom = Math.max(...painted.filter((p) => p.kind === 'dot').map((d) => d.y + d.size));
  const tableTop = Math.min(...painted.filter((p) => p.kind === 'rect').map((r) => r.y));
  expect(tableTop).toBeGreaterThanOrEqual(dotsBottom - 0.01);
});

it('keeps a heading with a paragraph whose 傍点 hang below its last line', async () => {
  const blocks: DocumentBlock[] = [
    {
      id: 'h',
      type: 'heading',
      level: 2,
      text: '見出し',
      style: { fontSize: 25.5, lineHeight: 1, spaceAfter: 0 },
    },
    {
      id: 'p',
      type: 'paragraph',
      text: '東京',
      style: { lineHeight: 1, spaceAfter: 0 },
      rich: [{ text: '東京', ruby, emphasisDots: true }],
    },
  ];
  const renderer = new DocumentPrintRenderer(794, 1123, 24);
  (renderer as unknown as { y: number }).y = 1032;
  await renderer.block(blocks, 0);
  await renderer.block(blocks, 1);
  const heading = painted.find((p) => p.text === '見')!;
  const body = painted.find((p) => p.text === '東')!;
  expect(heading.page).toBe(body.page);
});

it('keeps a highlighted line clear of the 傍点 under the ruby above it', async () => {
  const paragraph: DocumentBlock = {
    id: 'p',
    type: 'paragraph',
    text: '東京\n本当',
    // 144px text at line height 1.2: one ruby per line, then a highlighted plain line.
    style: { fontSize: 108, lineHeight: 1.2 },
    rich: [
      { text: '東京', ruby, emphasisDots: true },
      { text: '\n本当', highlight: '#fff3a3' },
    ],
  };
  const renderer = new DocumentPrintRenderer(794, 1123, 24);
  await renderer.block([paragraph], 0);
  const dots = painted.filter((p) => p.kind === 'dot');
  const highlight = painted.filter((p) => p.kind === 'fill' && p.text === '').at(-1)!;
  expect(dots.length).toBeGreaterThan(0);
  expect(Math.max(...dots.map((d) => d.y + d.size))).toBeLessThanOrEqual(highlight.y + 0.01);
});

it('keeps a reading clear of the highlight on the line before it', async () => {
  const paragraph: DocumentBlock = {
    id: 'p',
    type: 'paragraph',
    text: '本当\n東京',
    rich: [
      { text: '本当\n', highlight: '#fff3a3' },
      { text: '東京', ruby },
    ],
  };
  const renderer = new DocumentPrintRenderer(794, 1123, 24);
  await renderer.block([paragraph], 0);
  const highlight = painted.filter((p) => p.kind === 'fill').at(-1)!;
  const reading = painted.find((p) => p.text === 'とうきょう')!;
  // The reading's glyphs (ascent 0.88em) start below the highlight's bottom.
  expect(reading.y - reading.size * 0.88).toBeGreaterThanOrEqual(
    highlight.y + highlight.size - 0.01,
  );
});
