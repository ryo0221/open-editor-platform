import { expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { build } from 'esbuild';
import { contentHash } from '@editor-platform/artifact-core';
import { shapeNames } from '@editor-platform/editor-core';
import {
  captureSlideExportSnapshot,
  prepareSlidePptx,
  encodeSlidePptx,
  type SlidePptxPlan,
  type PptxAdapters,
} from '@editor-platform/slide-export';
import { contractDeck, contractFont, contractOptions, contractPng } from './fixtures';
import { ownedSlidePptxPlan } from './plan';
import { encodeOwnedPptx } from './pptxgen-adapter';
import { pptxImagePlacement, transformDrawingBox, shapeRasterBounds } from './geometry';

const consent = (p: SlidePptxPlan) => ({
  planHash: p.report.planHash,
  acceptedDiagnosticIds: p.report.diagnostics.filter((d) => d.requiresAcceptance).map((d) => d.id),
});
async function prepare(
  deck = contractDeck(),
  adapters: PptxAdapters = {},
  options = contractOptions,
) {
  return prepareSlidePptx(
    await captureSlideExportSnapshot(deck, {
      kind: 'confirmed',
      artifactId: 'PRIVATE_ARTIFACT_SENTINEL',
      revision: 42,
    }),
    options,
    { resolveFont: async () => contractFont, ...adapters },
  );
}
async function encoded(plan: SlidePptxPlan) {
  expect(plan.report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  // Direct invocation exposes the underlying error if a pinned encoder format changes.
  const result = await encodeOwnedPptx(ownedSlidePptxPlan(plan)!);
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw Error('Output blocked');
  const files = unzipSync(result.bytes);
  return { ...result, files, xml: (path = 'ppt/slides/slide1.xml') => strFromU8(files[path]) };
}

it('G01/G02/G07 emits native rich Japanese text, exact page/table dimensions and complete mappings', async () => {
  const deck = contractDeck();
  deck.slides[0].objects.push({
    id: 'PRIVATE_ELEMENT_SENTINEL',
    type: 'table',
    text: '',
    fill: '#fff',
    bounds: { x: 50, y: 250, width: 400, height: 140 },
    table: {
      rows: [
        ['項目', '金額'],
        ['日本語 A&B', '6 < 200'],
      ],
      columnWidths: [270, 130],
      rowHeights: [60, 80],
    },
  });
  const p = await prepare(deck),
    before = await contentHash(deck),
    output = await encoded(p);
  expect(output.xml('ppt/presentation.xml')).toContain('cx="9144000" cy="5143500"');
  expect(output.xml()).toContain('<a:t>日本語</a:t>');
  expect(output.xml()).toContain('b="1"');
  expect(output.xml()).toContain('typeface="Noto Sans CJK JP"');
  expect(output.xml()).toContain('日本語 A&amp;B');
  expect(output.xml()).toContain('6 &lt; 200');
  expect(output.xml().match(/<a:tc>/g)).toHaveLength(4);
  expect(output.xml().match(/<a:tr h="(\d+)"/g)).toEqual(['<a:tr h="571500"', '<a:tr h="762000"']);
  expect(output.xml()).toContain('<a:gridCol w="2571750"/>');
  expect(output.xml()).toContain('marL="76200"');
  expect(output.xml()).not.toContain('<p:pic>');
  const ids = [...output.xml().matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]);
  expect(new Set(ids).size).toBe(ids.length);
  expect(output.report.elements.map((e) => e.outputPartNames.length)).toEqual([2, 1]);
  for (const e of output.report.elements)
    for (const part of e.outputPartNames) {
      const [path, name] = part.split('#');
      expect(output.xml(path)).toContain(`name="${name}"`);
    }
  for (const [path, bytes] of Object.entries(output.files))
    if (/\.xml$|\.rels$/.test(path)) {
      const xml = strFromU8(bytes);
      expect(xml).not.toContain('PRIVATE_');
      expect(xml).not.toContain('TargetMode="External"');
    }
  expect(await contentHash(deck)).toBe(before);
  expect(p.report.elements.every((e) => !e.outputPartNames.length)).toBe(true);
});

it('G04 encodes all 13 native shapes and only the consented remaining 12 as individual pictures', async () => {
  const deck = contractDeck(
    shapeNames.map((shape, i) => ({
      id: shape,
      type: 'shape',
      shape,
      text: '',
      fill: 'tomato',
      stroke: 'rgba(0,0,80,0.7)',
      dash: '4 2',
      bounds: { x: i * 25, y: 50, width: 40, height: 60 },
      rotation: 17,
      flipX: true,
      opacity: 0.7,
    })),
  );
  const p = await prepare(
    deck,
    {
      rasterize: async (r) =>
        contractPng(Math.ceil(r.bounds.width * r.scale), Math.ceil(r.bounds.height * r.scale)),
    },
    { ...contractOptions, fallback: 'element-png' },
  );
  const result = await encoded(p);
  expect(result.xml().match(/<p:pic>/g)).toHaveLength(12);
  expect(result.xml().match(/<p:sp>/g)).toHaveLength(13);
  expect(result.xml()).toContain('<a:custGeom>');
  expect(result.xml()).toContain('<a:custDash>');
  expect(result.report.counts.native + result.report.counts.approximated).toBe(13);
  expect(result.report.counts.rasterized).toBe(12);
  expect(result.report.elements.every((e) => e.outputPartNames.length === 1)).toBe(true);
});

it('G06 retains original PNG bytes and native crop with one outer rotation/flip', async () => {
  const image = contractPng(200, 100);
  const deck = contractDeck([
    {
      id: 'image',
      type: 'image',
      text: '',
      fill: 'none',
      src: 'private:ref',
      imageFit: 'fill',
      bounds: { x: 100, y: 100, width: 100, height: 100 },
      rotation: 90,
      flipX: true,
      crop: { x: 0, y: 0, scale: 1 },
      alt: '日本語 <alt>',
    },
  ]);
  const resolveAsset = vi.fn(async () => image);
  const p = await prepare(deck, { resolveAsset });
  image.bytes.fill(0);
  const result = await encoded(p);
  expect(result.xml()).toContain('<a:srcRect l="25000" r="25000" t="0" b="0"/>');
  expect(result.xml()).toContain('rot="5400000"');
  expect(result.xml()).toContain('flipH="1"');
  expect(result.xml()).toContain('descr="日本語 &lt;alt&gt;"');
  const media = Object.entries(result.files).filter(([path]) => /^ppt\/media\/.*\.png$/.test(path));
  expect(media).toHaveLength(1);
  expect(media[0][1]).toEqual(contractPng(200, 100).bytes);
  expect(resolveAsset).toHaveBeenCalledTimes(1);
});

it('G14 shares identical embedded media across slides while preserving independent pictures', async () => {
  const deck = contractDeck([
    {
      id: 'a',
      type: 'image',
      src: 'same',
      text: '',
      fill: 'none',
      alt: 'first',
      bounds: { x: 10, y: 20, width: 200, height: 100 },
    },
    {
      id: 'b',
      type: 'image',
      src: 'different',
      text: '',
      fill: 'none',
      alt: 'other',
      bounds: { x: 230, y: 40, width: 150, height: 90 },
    },
  ]);
  deck.slides.push({ ...structuredClone(deck.slides[0]), id: 'second' });
  deck.slides[1].objects[0].bounds.x = 80;
  deck.slides[1].objects[0].alt = 'moved';
  const result = await encoded(
    await prepare(deck, {
      resolveAsset: async (src) => (src === 'same' ? contractPng(200, 100) : contractPng(150, 90)),
    }),
  );
  const media = Object.keys(result.files).filter((p) => /^ppt\/media\/.*\.png$/.test(p));
  expect(media).toHaveLength(2);
  for (const p of [1, 2]) {
    const xml = result.xml(`ppt/slides/slide${p}.xml`);
    expect(xml.match(/<p:pic>/g)).toHaveLength(2);
    const rels = result.xml(`ppt/slides/_rels/slide${p}.xml.rels`);
    const targets = [...rels.matchAll(/Target="\.\.\/(media\/[^"/]+)"/g)].map((m) => `ppt/${m[1]}`);
    expect(targets).toHaveLength(2);
    expect(targets.every((target) => media.includes(target))).toBe(true);
    expect(result.files[targets[0]]).toEqual(contractPng(200, 100).bytes);
    expect(result.files[targets[1]]).toEqual(contractPng(150, 90).bytes);
  }
  expect(result.xml()).toContain('descr="first"');
  expect(result.xml('ppt/slides/slide2.xml')).toContain('descr="moved"');
  expect(result.xml('ppt/slides/slide2.xml')).toContain('<a:off x="762000" y="190500"/>');
  expect(result.report.elements.filter((e) => e.outputPartNames.length)).toHaveLength(4);
});

it('G05/G06 independently checks letterboxing/sub-box transforms and completely clipped images', async () => {
  const d = {
    id: 'i',
    kind: 'image' as const,
    text: '',
    fill: 'none',
    bounds: { x: 100, y: 200, width: 100, height: 80 },
    rotation: 90,
    flipX: true,
    imageFit: 'fit' as const,
  };
  expect(pptxImagePlacement(d, 200, 100)).toEqual({
    bounds: { x: 100, y: 215, width: 100, height: 50 },
    crop: { left: 0, right: 0, top: 0, bottom: 0 },
  });
  expect(transformDrawingBox({ x: 100, y: 200, width: 20, height: 20 }, d)).toEqual({
    x: 170,
    y: 270,
    width: 20,
    height: 20,
  });
  const deck = contractDeck([
    { ...d, type: 'image', src: 'test', crop: { x: 1000, y: 0, scale: 1 } },
  ]);
  const p = await prepare(deck, { resolveAsset: async () => contractPng() });
  expect(p.report.counts.omitted).toBe(1);
  expect(p.report.diagnostics.some((x) => x.code === 'IMAGE_EXCLUDED_BY_CROP')).toBe(true);
  expect((await encoded(p)).xml()).not.toContain('<p:pic>');
});

it('G03/G05 PNG fallback owns expanded local paint and applies the outer transform once', async () => {
  const deck = contractDeck([
    {
      id: 'star',
      type: 'shape',
      shape: 'star',
      text: '第一行\n第二行\n第三行',
      typography: { overflow: 'expand', fontSize: 30, padding: 4 },
      fill: '#f00',
      bounds: { x: 100, y: 200, width: 180, height: 50 },
      rotation: 45,
      flipY: true,
      opacity: 0.4,
    },
  ]);
  const rasterize = vi.fn(async (r: import('./types').PptxRasterRequest) => {
    expect(r.drawing).toMatchObject({ rotation: 0, flipX: false, flipY: false, opacity: 1 });
    expect(r.bounds).toEqual({ x: 99.5, y: 199.5, width: 181, height: 122 });
    return contractPng(Math.ceil(r.bounds.width * 2), Math.ceil(r.bounds.height * 2));
  });
  const p = await prepare(deck, { rasterize }, { ...contractOptions, fallback: 'element-png' });
  const output = await encoded(p);
  expect(rasterize).toHaveBeenCalledTimes(1);
  expect(output.xml().match(/<p:pic>/g)).toHaveLength(1);
  expect(output.xml()).not.toContain('<a:t>');
  expect(output.xml()).toContain('rot="2700000"');
  expect(output.xml()).toContain('flipV="1"');
});

it('G08/G13 notes are opt-in and escaped; selected pages retain source order and no source IDs', async () => {
  const deck = contractDeck();
  deck.width = 720;
  deck.height = 960;
  deck.slides[0].notes = '<script> & notes';
  deck.slides.push({ ...structuredClone(deck.slides[0]), id: 'page-2', hidden: true });
  const absent = await encoded(await prepare(deck));
  expect(
    Object.keys(absent.files)
      .filter((n) => /notesSlides\/notesSlide\d+\.xml$/.test(n))
      .map(absent.xml)
      .join(''),
  ).not.toContain('&lt;script&gt;');
  const p = await prepare(
    deck,
    {},
    {
      ...contractOptions,
      pageIds: ['page-2', 'page-1'],
      includeHiddenSlides: true,
      includeNotes: true,
    },
  );
  const result = await encoded(p);
  expect(result.report.selectedPageIds).toEqual(['page-1', 'page-2']);
  expect(result.xml('ppt/notesSlides/notesSlide1.xml')).toContain('&lt;script&gt; &amp; notes');
  expect(result.xml('ppt/presentation.xml')).toContain('cx="6858000" cy="9144000"');
});

it('G09/G11 refuses fabricated, stale or incomplete consent, errors and cancellation without bytes', async () => {
  const p = await prepare();
  expect(await encodeSlidePptx(structuredClone(p), consent(p))).toMatchObject({
    status: 'failed',
    code: 'INVALID_PLAN',
  });
  expect(await encodeSlidePptx(p, { ...consent(p), planHash: 'old' })).toMatchObject({
    status: 'blocked',
  });
  expect(
    await encodeSlidePptx(p, { planHash: p.report.planHash, acceptedDiagnosticIds: [] }),
  ).toMatchObject({ status: 'blocked' });
  const badDeck = contractDeck();
  badDeck.slides[0].objects[0].fill = 'var(--host-color)';
  const bad = await prepare(badDeck);
  expect(await encodeSlidePptx(bad, consent(bad))).toMatchObject({ status: 'blocked' });
  expect(bad.report.diagnostics.some((d) => d.code === 'COLOR_UNSUPPORTED')).toBe(true);
  const controller = new AbortController();
  controller.abort();
  expect(await encodeSlidePptx(p, consent(p), controller.signal)).toEqual({ status: 'cancelled' });
  const large = contractDeck(
    Array.from({ length: 100 }, (_, i) => ({
      id: `s${i}`,
      type: 'shape',
      text: '',
      fill: '#fff',
      bounds: { x: 0, y: 0, width: 10, height: 10 },
    })),
  );
  const big = await prepare(large),
    later = new AbortController();
  const pending = encodeSlidePptx(big, consent(big), later.signal);
  setTimeout(() => later.abort(), 0);
  expect(await pending).toEqual({ status: 'cancelled' });
  expect((await encodeSlidePptx(p, consent(p))).status).toBe('ok');
});

for (const platform of ['node', 'browser'] as const)
  it(`encoder bundles for ${platform} with its Office adapter confined to a lazy chunk`, async () => {
    const result = await build({
      stdin: {
        contents: `export { encodeSlidePptx } from '@editor-platform/slide-export';`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      splitting: true,
      outdir: 'unused',
      platform,
      format: 'esm',
      write: false,
      metafile: true,
    });
    const entry = Object.values(result.metafile!.outputs).find((o) => o.entryPoint === '<stdin>')!;
    expect(Object.keys(entry.inputs).some((p) => /pptxgenjs/.test(p))).toBe(false);
    expect(
      Object.keys(result.metafile!.inputs).some((p) => /react|editor-ui|canvas-ui/.test(p)),
    ).toBe(false);
    expect(
      Object.values(result.metafile!.outputs).some((o) =>
        Object.keys(o.inputs).some((p) => /pptxgenjs/.test(p)),
      ),
    ).toBe(true);
  });

it('includes the cloud curve beyond its bounds and reports unsupported native table styles', async () => {
  const bounds = shapeRasterBounds({
    id: 'cloud',
    kind: 'shape',
    shape: 'cloud',
    text: '',
    fill: 'red',
    bounds: { x: 100, y: 20, width: 110, height: 52 },
  });
  expect(bounds.x).toBe(100);
  expect(bounds.width).toBeCloseTo(112.754848, 4);
  const table = {
    id: 'table',
    type: 'table' as const,
    text: '',
    fill: '#fff',
    stroke: '#0050b4',
    bounds: { x: 40, y: 50, width: 300, height: 120 },
    table: {
      rows: [
        ['項目', '値'],
        ['透明度', '6'],
      ],
    },
  };
  const output = await encoded(await prepare(contractDeck([table])));
  expect(output.xml().match(/<a:tc>/g)).toHaveLength(4);
  for (const transform of [
    { rotation: 15 },
    { flipX: true },
    { opacity: 0.5 },
    { stroke: 'rgba(0,80,180,0.5)' },
  ]) {
    const p = await prepare(
      contractDeck([{ ...table, ...transform }]),
      {
        rasterize: async (r) =>
          contractPng(Math.ceil(r.bounds.width * 2), Math.ceil(r.bounds.height * 2)),
      },
      { ...contractOptions, fallback: 'element-png' },
    );
    expect(p.report.counts.rasterized).toBe(1);
    expect(p.report.diagnostics.find((d) => d.code === 'ELEMENT_RASTERIZED')?.message).toMatch(
      /cannot rotate or mirror|border transparency/,
    );
    const transformed = await encoded(p);
    expect(transformed.xml().match(/<p:pic>/g)).toHaveLength(1);
    expect(transformed.xml()).not.toContain('<a:tbl>');
  }
});

it('keeps an empty text object as an editable native text box with an output mapping', async () => {
  const deck = contractDeck();
  deck.slides[0].objects[0].text = '';
  deck.slides[0].objects[0].runs = [];
  const result = await encoded(await prepare(deck));
  expect(result.report.counts.native).toBe(1);
  expect(result.report.elements[0].outputPartNames).toEqual(['ppt/slides/slide1.xml#e1-text-1']);
  expect(result.xml()).toContain('name="e1-text-1"');
  expect(result.xml()).toContain('<p:txBody>');
});
it('keeps every generated content-type override attached to an existing OPC part', async () => {
  const deck = contractDeck();
  deck.slides.push({ ...structuredClone(deck.slides[0]), id: 'second-page' });
  const output = await encoded(await prepare(deck));
  const declarations = [
    ...output.xml('[Content_Types].xml').matchAll(/<Override\b[^>]*PartName="\/([^"]+)"/g),
  ].map((m) => m[1]);
  expect(new Set(declarations).size).toBe(declarations.length);
  for (const part of declarations)
    expect(output.files[part], `Override resolves to ${part}`).toBeDefined();
  expect(declarations.filter((p) => /^ppt\/slideMasters\//.test(p))).toHaveLength(1);
});
