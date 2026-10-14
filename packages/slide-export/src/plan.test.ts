import { expect, it, vi } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import {
  drawingPrimitives,
  layoutDrawingText,
  shapeNames,
  type Drawing,
} from '@editor-platform/editor-core';
import { acceptsExport, ExportAdapterError } from '@editor-platform/export-core';
import {
  captureSlideExportSnapshot,
  prepareSlidePptx,
  slidePptxCapabilities,
} from '@editor-platform/slide-export';
import { ownedSlidePptxPlan } from './plan';
import { contractDeck, contractFont, contractOptions, contractPng } from './fixtures';

const snapshot = (deck = contractDeck()) =>
  captureSlideExportSnapshot(deck, { kind: 'confirmed', artifactId: 'artifact', revision: 9 });
const adapters = () => ({ resolveFont: async () => structuredClone(contractFont) });
const codes = (plan: Awaited<ReturnType<typeof prepareSlidePptx>>) =>
  plan.report.diagnostics.map((d) => d.code);
const consent = (plan: Awaited<ReturnType<typeof prepareSlidePptx>>) => ({
  planHash: plan.report.planHash,
  acceptedDiagnosticIds: plan.report.diagnostics
    .filter((d) => d.requiresAcceptance)
    .map((d) => d.id),
});

it('captures input/options and owns resolved assets/font independently of callers and later revisions', async () => {
  const deck = contractDeck();
  deck.slides[0].objects.push({
    id: 'image',
    type: 'image',
    text: '',
    fill: 'none',
    src: 'host:asset',
    bounds: { x: 100, y: 200, width: 90, height: 90 },
  });
  const input = structuredClone(await snapshot(deck));
  const options = { ...contractOptions, pageIds: ['page-1'] };
  const image = contractPng(),
    font = structuredClone(contractFont);
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const resolveAsset = vi.fn(async () => {
    await held;
    return image;
  });
  const pending = prepareSlidePptx(input, options, { resolveFont: async () => font, resolveAsset });
  Object.assign(input.content.slides[0].objects[0], { text: 'remote / caller mutation' });
  Object.assign(input.basis, { artifactId: 'another' });
  options.pageIds.length = 0;
  options.includeNotes = true;
  release();
  const plan = await pending,
    state = ownedSlidePptxPlan(plan)!;
  const expectedHash = plan.report.planHash;
  image.bytes.fill(0);
  font.glyphRanges.length = 0;
  expect(state.pages[0].elements[0].drawing.text).toContain('日本語');
  expect(state.assets.get('source:host:asset')!.bytes[0]).toBe(137);
  expect(state.font!.glyphRanges.length).toBe(1);
  expect(plan.report.basis).toMatchObject({ artifactId: 'artifact', revision: 9 });
  expect(plan.report.planHash).toBe(expectedHash);
  expect(resolveAsset).toHaveBeenCalledTimes(1);
  expect(ownedSlidePptxPlan(structuredClone(plan))).toBeUndefined();
  expect(Object.keys(plan)).toEqual(['report']);
  expect(() => {
    (plan.report.diagnostics as unknown[]).push({});
  }).toThrow();
  expect(acceptsExport(plan.report, consent(plan))).toBe(true);
});

it('repeats deterministic reports and invalidates consent for content, assets, options or font manifest changes', async () => {
  const deck = contractDeck();
  const original = await snapshot(deck);
  const a = await prepareSlidePptx(original, contractOptions, adapters());
  expect((await prepareSlidePptx(original, contractOptions, adapters())).report).toEqual(a.report);
  deck.slides[0].objects[0].text += ' updated';
  const changed = await prepareSlidePptx(await snapshot(deck), contractOptions, adapters());
  const notes = await prepareSlidePptx(
    original,
    { ...contractOptions, includeNotes: true },
    adapters(),
  );
  const font = await prepareSlidePptx(original, contractOptions, {
    resolveFont: async () => ({ ...contractFont, version: 'changed' }),
  });
  for (const plan of [changed, notes, font]) {
    expect(plan.report.planHash).not.toBe(a.report.planHash);
    expect(acceptsExport(plan.report, consent(a))).toBe(false);
  }
  deck.slides[0].objects = [
    {
      id: 'image',
      type: 'image',
      text: '',
      fill: 'none',
      src: 'same',
      bounds: { x: 0, y: 0, width: 50, height: 50 },
    },
  ];
  const image = contractPng(),
    imageSnapshot = await snapshot(deck);
  const first = await prepareSlidePptx(imageSnapshot, contractOptions, {
    ...adapters(),
    resolveAsset: async () => image,
  });
  image.bytes[30] ^= 1; // Contract resolver supplies a different resolved binary at the same reference.
  const second = await prepareSlidePptx(imageSnapshot, contractOptions, {
    ...adapters(),
    resolveAsset: async () => image,
  });
  expect(second.report.planHash).not.toBe(first.report.planHash);
});

it('G04 classifies every shape: 13 native mappings and 12 explicit element fallbacks', async () => {
  const deck = contractDeck(
    shapeNames.map((shape, i) => ({
      id: shape,
      type: 'shape',
      shape,
      text: '',
      fill: '#123456',
      bounds: { x: i * 15, y: 20, width: 50, height: 50 },
    })),
  );
  const reject = await prepareSlidePptx(await snapshot(deck), contractOptions, adapters());
  expect(reject.report.diagnostics.filter((d) => d.code === 'UNSUPPORTED_ELEMENT')).toHaveLength(
    12,
  );
  const rasterize = vi.fn(async (request: import('./types').PptxRasterRequest) =>
    contractPng(
      Math.max(1, Math.ceil(request.bounds.width * request.scale)),
      Math.max(1, Math.ceil(request.bounds.height * request.scale)),
    ),
  );
  const plan = await prepareSlidePptx(
    await snapshot(deck),
    { ...contractOptions, fallback: 'element-png' },
    { ...adapters(), rasterize },
  );
  expect(plan.report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(plan.report.counts.native + plan.report.counts.approximated).toBe(13);
  expect(plan.report.counts.rasterized).toBe(12);
  expect(rasterize).toHaveBeenCalledTimes(12);
  expect(
    acceptsExport(plan.report, { planHash: plan.report.planHash, acceptedDiagnosticIds: [] }),
  ).toBe(false);
  expect(acceptsExport(plan.report, consent(plan))).toBe(true);
  expect(slidePptxCapabilities.nativeShapes).toHaveLength(13);
});

it('G05 preserves world-coordinate nested children and hierarchy paint order without double translation', async () => {
  const base = { text: '', fill: '#123456', bounds: { x: 100, y: 120, width: 60, height: 70 } };
  const deck = contractDeck([
    { ...base, id: 'child', type: 'shape', groupId: 'inner' },
    { ...base, id: 'outer', type: 'group' },
    { ...base, id: 'inner', type: 'group', groupId: 'outer' },
    { ...base, id: 'top', type: 'shape', hidden: true },
  ]);
  const plan = await prepareSlidePptx(await snapshot(deck), contractOptions, adapters());
  const elements = ownedSlidePptxPlan(plan)!.pages[0].elements;
  expect(elements.map((e) => e.drawing.id)).toEqual(['outer', 'inner', 'child', 'top']);
  expect(elements[2].drawing.bounds).toEqual(base.bounds);
  expect(plan.report.counts).toEqual({ native: 1, approximated: 0, rasterized: 0, omitted: 1 });
  expect(plan.report.diagnostics.filter((d) => d.code === 'GROUP_FLATTENED')).toHaveLength(2);
});

it('G02/G03 reuses fitted line layout and reports clipped/complex text rather than truncating it', async () => {
  const deck = contractDeck();
  const text = deck.slides[0].objects[0];
  text.bounds = { x: 3, y: 4, width: 90, height: 70 };
  text.typography = { fontSize: 32, overflow: 'fit', lineHeight: 1.2, padding: 7 };
  const plan = await prepareSlidePptx(await snapshot(deck), contractOptions, adapters());
  const e = ownedSlidePptxPlan(plan)!.pages[0].elements[0];
  expect(e.textLayout).toEqual(layoutDrawingText(e.drawing));
  expect(e.textLayout!.fontSize).toBeLessThan(32);
  expect(
    e
      .textLayout!.lines.flatMap((l) => l.runs)
      .map((r) => r.text)
      .join(''),
  ).toBe(text.text.replaceAll('\n', ''));
  text.bounds.height = 10;
  text.typography.overflow = 'clip';
  expect(
    codes(await prepareSlidePptx(await snapshot(deck), contractOptions, adapters())),
  ).toContain('UNSUPPORTED_ELEMENT');
  text.text = '🙂';
  text.bounds.height = 200;
  expect(
    codes(await prepareSlidePptx(await snapshot(deck), contractOptions, adapters())),
  ).toContain('TEXT_SHAPING_UNVERIFIED');
});

it('G06 resolves source images before fallback and never hides an unavailable asset', async () => {
  const deck = contractDeck([
    {
      id: 'image',
      type: 'image',
      text: '',
      fill: 'none',
      src: 'source',
      bounds: { x: 0, y: 0, width: 80, height: 90 },
      crop: { x: -20, y: -5, scale: 2 },
    },
  ]);
  const rasterize = vi.fn(async (request: import('./types').PptxRasterRequest) =>
    contractPng(
      Math.max(1, Math.ceil(request.bounds.width * request.scale)),
      Math.max(1, Math.ceil(request.bounds.height * request.scale)),
    ),
  );
  const failed = await prepareSlidePptx(
    await snapshot(deck),
    { ...contractOptions, fallback: 'element-png' },
    {
      ...adapters(),
      resolveAsset: async () => {
        throw Error('Unavailable');
      },
      rasterize,
    },
  );
  expect(codes(failed)).toContain('ASSET_UNAVAILABLE');
  expect(rasterize).not.toHaveBeenCalled();
  expect(acceptsExport(failed.report, consent(failed))).toBe(false);
  const plan = await prepareSlidePptx(await snapshot(deck), contractOptions, {
    ...adapters(),
    resolveAsset: async () => contractPng(),
  });
  expect(ownedSlidePptxPlan(plan)!.pages[0].elements[0].drawing.crop).toEqual({
    x: -20,
    y: -5,
    scale: 2,
  });
  expect(plan.report.counts.native).toBe(1);
});

it('G07 keeps native simple cell structure, exposes fixed-row overflow and diagnoses merged table fallback', async () => {
  const deck = contractDeck([
    {
      id: 'table',
      type: 'table',
      text: '',
      fill: '#fff',
      bounds: { x: 12, y: 23, width: 500, height: 160 },
      table: {
        rows: [
          ['項目', '数'],
          ['日本語', '6'],
        ],
        columnWidths: [350, 150],
        rowHeights: [70, 90],
      },
    },
  ]);
  const first = await prepareSlidePptx(await snapshot(deck), contractOptions, adapters());
  const cells = ownedSlidePptxPlan(first)!.pages[0].elements[0].tableCells!;
  expect(cells.map((c) => c.text)).toEqual(['項目', '数', '日本語', '6']);
  expect(cells[3].bounds).toEqual({ x: 362, y: 93, width: 150, height: 90 });
  deck.slides[0].objects[0].table!.rowHeights = [5, 90];
  expect(
    codes(await prepareSlidePptx(await snapshot(deck), contractOptions, adapters())),
  ).toContain('TEXT_LAYOUT_UNREPRESENTABLE');
  deck.slides[0].objects[0].table!.merges = [{ row: 0, col: 0, rows: 1, cols: 2 }];
  expect(
    codes(await prepareSlidePptx(await snapshot(deck), contractOptions, adapters())),
  ).toContain('UNSUPPORTED_ELEMENT');
});

it('reports schema/hash/options/page/font errors and never lets consent bypass them', async () => {
  const bad = structuredClone(await snapshot());
  Object.assign(bad.content, { width: 99 });
  const plan = await prepareSlidePptx(
    bad,
    { ...contractOptions, pageIds: ['absent', 'absent'] },
    {},
  );
  expect(codes(plan)).toEqual(
    expect.arrayContaining([
      'SNAPSHOT_HASH_MISMATCH',
      'PAGE_SIZE_UNSUPPORTED',
      'INVALID_PAGE_SELECTION',
      'ADAPTER_UNAVAILABLE',
    ]),
  );
  expect(acceptsExport(plan.report, consent(plan))).toBe(false);
  const missing = await prepareSlidePptx(await snapshot(), contractOptions, {
    resolveFont: async () => ({ ...contractFont, glyphRanges: [[32, 126]] }),
  });
  expect(codes(missing)).toContain('FONT_GLYPH_MISSING');
  const invalid = await prepareSlidePptx({ content: null } as never, contractOptions, adapters());
  expect(codes(invalid)).toEqual(['INVALID_CONTENT']);
});

it('G08 exports selection in source order, reports omissions and keeps notes opt-in', async () => {
  const deck = contractDeck();
  deck.slides[0].notes = 'optional notes';
  deck.slides.push(
    { ...structuredClone(deck.slides[0]), id: 'hidden', hidden: true },
    { ...structuredClone(deck.slides[0]), id: 'last' },
  );
  const plan = await prepareSlidePptx(
    await snapshot(deck),
    { ...contractOptions, pageIds: ['last', 'hidden', 'page-1'] },
    adapters(),
  );
  expect(plan.report.selectedPageIds).toEqual(['page-1', 'last']);
  expect(codes(plan)).toEqual(expect.arrayContaining(['NOTES_EXCLUDED', 'HIDDEN_SLIDE_EXCLUDED']));
  expect(ownedSlidePptxPlan(plan)!.pages.every((p) => p.notes === undefined)).toBe(true);
});

it('G11 cancels before and during adapters, with no plan or source mutation', async () => {
  const input = await snapshot(),
    before = await contentHash(input);
  const controller = new AbortController();
  controller.abort();
  await expect(
    prepareSlidePptx(input, contractOptions, adapters(), controller.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
  const later = new AbortController();
  await expect(
    prepareSlidePptx(
      input,
      contractOptions,
      {
        resolveFont: async (_id, signal) => {
          expect(signal).toBe(later.signal);
          later.abort();
          return contractFont;
        },
      },
      later.signal,
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(await contentHash(input)).toBe(before);
});

it('shared layout extraction keeps the SVG primitive coordinates and fitted run sizes', () => {
  const drawing: Drawing = {
    ...contractDeck().slides[0].objects[0],
    kind: 'text',
    typography: { fontSize: 32, padding: 8, verticalAlign: 'middle', overflow: 'fit' },
  };
  const layout = layoutDrawingText(drawing);
  const text = drawingPrimitives(drawing)[0].children![1] as {
    children: { children: { attrs: Record<string, number> }[] }[];
  };
  const lines = text.children[0].children;
  expect(lines[0].attrs.x).toBe(layout.x);
  expect(lines[0].attrs.y).toBe(layout.startY + layout.lines[0].ascent);
});

it('raster and source asset keys cannot collide, and incorrectly sized raster results block', async () => {
  const deck = contractDeck([
    {
      id: 'picture',
      type: 'image',
      src: 'raster:page-1:star',
      text: '',
      fill: 'none',
      bounds: { x: 0, y: 0, width: 20, height: 20 },
    },
    {
      id: 'star',
      type: 'shape',
      shape: 'star',
      text: '',
      fill: '#fff',
      bounds: { x: 40, y: 0, width: 30, height: 30 },
    },
  ]);
  const options = { ...contractOptions, fallback: 'element-png' as const };
  const services = {
    ...adapters(),
    resolveAsset: async () => contractPng(),
    rasterize: async (r: import('./types').PptxRasterRequest) =>
      contractPng(Math.ceil(r.bounds.width * r.scale), Math.ceil(r.bounds.height * r.scale)),
  };
  const plan = await prepareSlidePptx(await snapshot(deck), options, services);
  const state = ownedSlidePptxPlan(plan)!;
  const [picture, star] = state.pages[0].elements;
  expect(state.assets.get(picture.imageKey!)!.width).toBe(1);
  expect(state.assets.get(star.imageKey!)!.width).toBe(62);
  expect(picture.imageKey).not.toBe(star.imageKey);
  const bad = await prepareSlidePptx(await snapshot(deck), options, {
    ...services,
    rasterize: async () => contractPng(),
  });
  expect(codes(bad)).toContain('RASTER_FAILED');
  expect(acceptsExport(bad.report, consent(bad))).toBe(false);
  const cropped = await prepareSlidePptx(await snapshot(deck), options, {
    ...services,
    rasterize: async (r) => ({
      ...contractPng(10, 10),
      bounds: { ...r.bounds, width: 5, height: 5 },
    }),
  });
  expect(codes(cropped)).toContain('RASTER_FAILED');
});

it('known raster style limitations are structured, non-waivable errors', async () => {
  const deck = contractDeck();
  deck.slides[0].objects[0].flipX = true;
  const p = await prepareSlidePptx(
    await snapshot(deck),
    { ...contractOptions, fallback: 'element-png' },
    {
      ...adapters(),
      rasterize: async () => {
        throw new ExportAdapterError(
          'RASTER_TEXT_STYLE_UNSUPPORTED',
          'This profile cannot synthesize italic',
        );
      },
    },
  );
  expect(codes(p)).toContain('RASTER_TEXT_STYLE_UNSUPPORTED');
  expect(acceptsExport(p.report, consent(p))).toBe(false);
});

it('G15 enforces per-image bytes, decoded pixels and the combined asset budget before encoding', async () => {
  const make = (size: number) => {
    const asset = contractPng();
    const bytes = new Uint8Array(size);
    bytes.set(asset.bytes);
    return { ...asset, bytes };
  };
  const limit = 16 * 1024 * 1024;
  const object = {
    id: 'image',
    type: 'image' as const,
    text: '',
    fill: 'none',
    src: 'image',
    bounds: { x: 0, y: 0, width: 100, height: 100 },
  };
  for (const size of [limit - 1, limit, limit + 1]) {
    const p = await prepareSlidePptx(await snapshot(contractDeck([object])), contractOptions, {
      ...adapters(),
      resolveAsset: async () => make(size),
    });
    expect(codes(p).includes('ASSET_INVALID')).toBe(size > limit);
  }
  for (const pixels of [31_999_999, 32_000_000, 32_000_001]) {
    // Trust-boundary fixture: decoder dimensions are injected; this checks the plan's independent cap.
    const asset = contractPng();
    new DataView(asset.bytes.buffer).setUint32(20, pixels);
    asset.height = pixels;
    const p = await prepareSlidePptx(await snapshot(contractDeck([object])), contractOptions, {
      ...adapters(),
      resolveAsset: async () => asset,
    });
    expect(codes(p).includes('ASSET_INVALID')).toBe(pixels > 32_000_000);
  }
  for (const extra of [-1, 0, 1]) {
    let index = 0;
    const p = await prepareSlidePptx(
      await snapshot(
        contractDeck(
          Array.from({ length: extra === 1 ? 5 : 4 }, (_, i) => ({
            ...object,
            id: `image-${i}`,
            src: `image-${i}`,
          })),
        ),
      ),
      contractOptions,
      {
        ...adapters(),
        resolveAsset: async () => {
          index++;
          return make(index === 5 ? 100 : index === 4 && extra === -1 ? limit - 1 : limit);
        },
      },
    );
    expect(codes(p).includes('ASSET_INVALID')).toBe(extra === 1);
  }
});
