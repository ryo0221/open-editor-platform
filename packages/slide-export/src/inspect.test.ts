import { readFile } from 'node:fs/promises';
import { beforeAll, expect, it } from 'vitest';
import { prepareOfficeFonts, type OfficeFontManifest } from '@editor-platform/office-adapters';
import type { SlideContent, SlideObject } from '@editor-platform/slide/model';
import {
  createSlideInspector,
  estimateSlideTextOverflow,
  SlideInspectError,
  type SlideInspector,
} from './inspect';

let inspector: SlideInspector;
beforeAll(async () => {
  const root = 'apps/playground/public/office-fonts/';
  const manifest = JSON.parse(await readFile(root + 'manifest.json', 'utf8')) as OfficeFontManifest;
  const fonts = await prepareOfficeFonts(
    manifest,
    await Promise.all(manifest.faces.map((f) => readFile(root + f.file))),
  );
  inspector = await createSlideInspector(
    await readFile('node_modules/@resvg/resvg-wasm/index_bg.wasm'),
    fonts,
  );
});

const box = (id: string, text: string, extra: Partial<SlideObject> = {}): SlideObject => ({
  id,
  type: 'text',
  bounds: { x: 40, y: 40, width: 300, height: 60 },
  text,
  fill: '#202020',
  typography: { fontSize: 24 },
  ...extra,
});
const deck = (objects: SlideObject[], hidden = false): SlideContent => ({
  schemaVersion: 2,
  width: 960,
  height: 540,
  slides: [
    { id: 's1', title: '収支', background: '#ffffff', objects },
    { id: 's2', title: '非表示', background: '#ffffff', objects, hidden },
  ],
});
const long = '新規事業の収支の見通しを、三つのシナリオで比べて説明します。'.repeat(4);

it('renders a slide to a PNG of the requested scale, the same every time', () => {
  const content = deck([box('o1', '売上 1.2 億円')]);
  const first = inspector.renderPng(content, 's1', { scale: 0.5 });
  expect([first.width, first.height]).toEqual([480, 270]);
  expect([...first.png.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
  expect(inspector.renderPng(content, 's1', { scale: 0.5 }).png).toEqual(first.png);
  expect(inspector.renderPng(deck([]), 's1', { scale: 0.5 }).png).not.toEqual(first.png);
});

it('refuses a deck that is not one, an unknown slide and a bad scale with a reason', () => {
  const content = deck([]);
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e instanceof SlideInspectError ? e.code : String(e);
    }
  };
  expect(code(() => inspector.renderPng({ slides: 1 }, 's1'))).toBe('INVALID_DECK');
  expect(code(() => inspector.renderPng(content, 'nope'))).toBe('UNKNOWN_SLIDE');
  expect(code(() => inspector.renderPng(content, 's1', { scale: 5 }))).toBe('INVALID_SCALE');
  expect(code(() => inspector.textOverflow(content, { slideId: 'nope' }))).toBe('UNKNOWN_SLIDE');
});

it('finds clipped, shrunk and off-slide text on every visible slide at once', () => {
  const content = deck(
    [
      box('fits', '売上'),
      box('clipped', long),
      box('shrunk', long, {
        bounds: { x: 40, y: 120, width: 300, height: 120 },
        typography: { fontSize: 24, overflow: 'fit' },
      }),
      box('off', '右端からはみ出す見出し', { bounds: { x: 900, y: 300, width: 300, height: 60 } }),
      box('hiddenObject', long, { hidden: true }),
    ],
    true,
  );
  for (const issues of [inspector.textOverflow(content), estimateSlideTextOverflow(content)]) {
    const found = issues.map((i) => [i.slideId, i.objectId, i.kind]);
    expect(found).toContainEqual(['s1', 'clipped', 'clipped']);
    expect(found).toContainEqual(['s1', 'shrunk', 'shrunk']);
    expect(found).toContainEqual(['s1', 'off', 'outside-slide']);
    expect(found.some(([, id]) => id === 'fits' || id === 'hiddenObject')).toBe(false);
    expect(found.some(([slide]) => slide === 's2')).toBe(false);
    const shrunk = issues.find((i) => i.kind === 'shrunk')!;
    expect(shrunk.fontSize).toBeLessThan(shrunk.setFontSize!);
  }
  expect(inspector.textOverflow(content, { slideId: 's2' }).map((i) => i.slideId)).toContain('s2');
});

it('measures glyphs a line estimate cannot: one long word wider than its box', () => {
  const content = deck([
    box('wide', 'WWWWWWWWWWWWWWWWWWWW', { bounds: { x: 40, y: 40, width: 120, height: 200 } }),
  ]);
  const measured = inspector.textOverflow(content, { slideId: 's1' });
  expect(measured.map((i) => [i.objectId, i.kind])).toEqual([['wide', 'clipped']]);
  expect(measured[0].painted.width).toBeGreaterThan(120);
  expect(estimateSlideTextOverflow(content, { slideId: 's1' })).toEqual([]);
});
