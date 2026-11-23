import { expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { build } from 'esbuild';
import { contentHash } from '@editor-platform/artifact-core';
import { insertSlideCitation, slideMotionState } from '@editor-platform/slide/model';
import { shapeNames, usesGridText, type Drawing } from '@editor-platform/editor-core';
import {
  captureSlideExportSnapshot,
  prepareSlidePptx,
  encodeSlidePptx,
  type SlidePptxPlan,
  type PptxAdapters,
  type PptxFigureReference,
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

it('declares Japanese charsets so PowerPoint substitutes a Japanese font, not a Chinese one', async () => {
  const output = await encoded(await prepare());
  const xmlParts = Object.keys(output.files).filter((path) => /^ppt\/.+\.xml$/.test(path));
  const all = xmlParts.map((path) => output.xml(path)).join('\n');
  expect(output.xml()).toMatch(/<a:ea typeface="Noto Sans CJK JP"[^>]*charset="-128"\/>/);
  expect(output.xml()).toMatch(/<a:cs typeface="Noto Sans CJK JP"[^>]*charset="0"\/>/);
  expect(all).not.toMatch(/<a:ea\b[^>]*charset="-122"/);
  expect(all).not.toMatch(/<a:cs\b[^>]*charset="-120"/);
});

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

it('keeps vertical text as a picture instead of horizontal Office text (Codex on #29)', async () => {
  const deck = contractDeck();
  const text = deck.slides[0].objects[0];
  text.text = '台詞';
  text.runs = [];
  text.typography = { ...text.typography, writingMode: 'vertical-rl' };
  const p = await prepare(
    deck,
    {
      rasterize: async (r) =>
        contractPng(Math.ceil(r.bounds.width * 2), Math.ceil(r.bounds.height * 2)),
    },
    { ...contractOptions, fallback: 'element-png' },
  );
  expect(p.report.counts.rasterized).toBe(1);
  expect(p.report.diagnostics.find((d) => d.code === 'ELEMENT_RASTERIZED')?.message).toMatch(
    /Vertical writing and ruby/,
  );
  expect((await encoded(p)).xml()).not.toContain('<p:txBody>');
});

it('keeps horizontal ruby with plain runs on the grid through export fonts (Codex on #29)', async () => {
  const deck = contractDeck();
  const text = deck.slides[0].objects[0];
  text.text = '漢字《かんじ》';
  text.runs = [{ text: '漢字《かんじ》' }];
  const drawings: Drawing[] = [];
  const p = await prepare(
    deck,
    {
      rasterize: async (r) => {
        drawings.push(r.drawing);
        return contractPng(Math.ceil(r.bounds.width * 2), Math.ceil(r.bounds.height * 2));
      },
    },
    { ...contractOptions, fallback: 'element-png' },
  );
  expect(p.report.counts.rasterized).toBe(1);
  // The export font is written onto the runs too, and the drawing still lays out on the grid.
  expect(drawings[0]!.runs![0]!.style?.fontFamily).toBe(drawings[0]!.typography?.fontFamily);
  expect(usesGridText(drawings[0]!)).toBe(true);
});

it('keeps a table with ruby in a cell as a picture (Codex on #29)', async () => {
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
        ['漢字《かんじ》', '6'],
      ],
    },
  };
  const p = await prepare(
    contractDeck([table]),
    {
      rasterize: async (r) =>
        contractPng(Math.ceil(r.bounds.width * 2), Math.ceil(r.bounds.height * 2)),
    },
    { ...contractOptions, fallback: 'element-png' },
  );
  expect(p.report.counts.rasterized).toBe(1);
  expect(p.report.diagnostics.find((d) => d.code === 'ELEMENT_RASTERIZED')?.message).toMatch(
    /Vertical writing and ruby/,
  );
  expect((await encoded(p)).xml()).not.toContain('<a:tbl>');
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

function motionId(kind: 'step' | 'effect', number: number) {
  return `${kind}_00000000-0000-4000-8000-${number.toString().padStart(12, '0')}`;
}

it('encodes click steps on all final text and shape parts and uses their shared playback pivots', async () => {
  const deck = contractDeck();
  deck.schemaVersion = 3;
  const page = deck.slides[0];
  const [text] = page.objects;
  const box = {
    ...text,
    id: 'labeled-box',
    type: 'shape' as const,
    shape: 'rectangle' as const,
    bounds: { x: 200, y: 260, width: 440, height: 150 },
    rotation: 17,
  };
  page.objects.unshift({
    id: 'table-before-text',
    type: 'table',
    text: '',
    fill: '#fff',
    bounds: { x: 730, y: 100, width: 160, height: 90 },
    table: { rows: [['A']] },
  });
  page.objects.push(box, { ...text, id: 'hidden', hidden: true });
  page.steps = [
    {
      id: motionId('step', 1),
      effects: [
        {
          id: motionId('effect', 1),
          targetId: text.id,
          phase: 'enter',
          effect: 'fade',
          trigger: 'on-click',
          delayMs: 35,
          durationMs: 200,
        },
        {
          id: motionId('effect', 2),
          targetId: box.id,
          phase: 'enter',
          effect: 'zoom',
          trigger: 'with-previous',
          delayMs: 15,
          durationMs: 500,
        },
        {
          id: motionId('effect', 3),
          targetId: 'hidden',
          phase: 'enter',
          effect: 'fade',
          trigger: 'after-previous',
          delayMs: 11,
          durationMs: 50,
        },
      ],
    },
    {
      id: motionId('step', 2),
      effects: [
        {
          id: motionId('effect', 4),
          targetId: text.id,
          phase: 'emphasis',
          effect: 'zoom',
          trigger: 'on-click',
          delayMs: 0,
          durationMs: 301,
        },
        {
          id: motionId('effect', 5),
          targetId: box.id,
          phase: 'exit',
          effect: 'fade',
          trigger: 'after-previous',
          delayMs: 14,
          durationMs: 290,
        },
      ],
    },
    {
      id: motionId('step', 3),
      effects: [
        {
          id: motionId('effect', 6),
          targetId: box.id,
          phase: 'enter',
          effect: 'slide-in',
          direction: 'right',
          trigger: 'on-click',
          delayMs: 0,
          durationMs: 125,
        },
        {
          id: motionId('effect', 7),
          targetId: text.id,
          phase: 'exit',
          effect: 'zoom',
          trigger: 'with-previous',
          delayMs: 0,
          durationMs: 382,
        },
      ],
    },
    {
      id: motionId('step', 4),
      effects: [
        {
          id: motionId('effect', 8),
          targetId: box.id,
          phase: 'exit',
          effect: 'slide-out',
          direction: 'up',
          trigger: 'on-click',
          delayMs: 0,
          durationMs: 125,
        },
      ],
    },
  ];
  const output = await encoded(await prepare(deck));
  const xml = output.xml();
  const shapeId = (name: string) =>
    Number(xml.match(new RegExp('id="(\\d+)" name="' + name + '"'))?.[1]);
  const parts = (objectId: string) =>
    output.report.elements
      .find(({ address }) => address.elementId === objectId)!
      .outputPartNames.map((part) => shapeId(part.split('#')[1]));
  const [line1, line2] = parts(text.id);
  const [body, label1, label2] = parts(box.id);
  expect(new Set([line1, line2, body, label1, label2]).size).toBe(5);
  expect([line1, line2, body, label1, label2].every(Number.isSafeInteger)).toBe(true);
  const timing = xml.slice(xml.indexOf('<p:timing>'));
  expect(timing.match(/delay="indefinite"/g)).toHaveLength(4);
  expect(timing.match(/nodeType="clickEffect"/g)).toHaveLength(4);
  expect(timing.match(/nodeType="afterEffect"/g)).toHaveLength(2);
  expect(timing.match(/nodeType="withEffect"/g)).toHaveLength(13);
  expect(timing).toContain('delay="35"');
  expect(timing).toContain('delay="50"');
  expect(timing).toContain('delay="561"');
  expect(timing).toContain('delay="315"');
  expect(timing).toContain('evt="onPrev"');
  expect(timing).toContain('evt="onNext"');
  const nodes = [...timing.matchAll(/<p:cTn id="\d+" (presetID="[\s\S]*?)<\/p:childTnLst>/g)].map(
    ([, contents]) => ({ contents, id: Number(contents.match(/<p:spTgt spid="(\d+)"/)?.[1]) }),
  );
  const affected = (match: string) =>
    nodes.filter(({ contents }) => contents.includes(match)).map(({ id }) => id);
  expect(affected('transition="in" filter="fade"')).toEqual([line1, line2]);
  expect(affected('transition="out" filter="fade"')).toEqual([body, label1, label2]);
  expect(affected('presetClass="emph" presetSubtype="0"')).toEqual([line1, line2]);
  expect(affected('<p:from x="0" y="0"/>')).toEqual([body, label1, label2]);
  expect(affected('<p:to x="0" y="0"/>')).toEqual([line1, line2]);
  expect(affected('presetID="0"')).toEqual([shapeId('timing-marker')]);
  expect(affected('presetID="2" presetClass="entr"')).toEqual([body, label1, label2]);
  expect(affected('presetID="2" presetClass="exit"')).toEqual([body, label1, label2]);
  const timeIds = [...timing.matchAll(/<p:cTn id="(\d+)"/g)].map((m) => m[1]);
  expect(new Set(timeIds).size).toBe(timeIds.length);

  // Recover each placed line center from the ZIP. At half zoom the XML translation
  // must put it exactly where the presentation's transform about the whole object does.
  for (const id of [body, label1, label2]) {
    const shape = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].find(([part]) =>
      part.includes(`<p:cNvPr id="${id}"`),
    )![0];
    const [, x, y, w, h] = shape
      .match(/<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/)!
      .map(Number);
    const center = [(x + w / 2) / 9525, (y + h / 2) / 9525];
    const zoom = nodes.find(
      (node) => node.id === id && node.contents.includes('<p:animScale>'),
    )!.contents;
    const state = slideMotionState(deck, page, 1, 300).get(box.id)!;
    expect(state.scale).toBe(0.5);
    for (const [axis, attribute, size, pivot] of [
      [0, 'ppt_x', deck.width, box.bounds.x + box.bounds.width / 2],
      [1, 'ppt_y', deck.height, box.bounds.y + box.bounds.height / 2],
    ] as const) {
      const suffix = zoom.match(new RegExp('val="#' + attribute + '([+-][0-9.]+)"'))?.[1] ?? '0';
      expect(center[axis] + (Number(suffix) * size) / 2).toBeCloseTo(
        pivot + (center[axis] - pivot) * state.scale,
        5,
      );
    }
  }
  expect(slideMotionState(deck, page, 0).get(box.id)?.visible).toBe(false);
  expect(slideMotionState(deck, page, 1).get(box.id)?.visible).toBe(true);
  expect(slideMotionState(deck, page, 2).get(box.id)?.visible).toBe(false);
  expect(slideMotionState(deck, page, 3).get(text.id)?.visible).toBe(false);
});

it('keeps directional push and exact transition timing in selected slide order', async () => {
  const deck = contractDeck();
  deck.schemaVersion = 3;
  const [first] = deck.slides;
  first.transition = { kind: 'fade', durationMs: 777 };
  deck.slides.push(
    { ...first, id: 'excluded', hidden: true, objects: [] },
    { ...first, id: 'fade', objects: [], transition: { kind: 'fade', durationMs: 275 } },
    ...(['left', 'right', 'up', 'down'] as const).map((direction) => ({
      ...first,
      id: direction,
      objects: [],
      transition: { kind: 'push' as const, direction, durationMs: 711 },
    })),
  );
  const output = await encoded(await prepare(deck));
  expect(output.report.selectedPageIds).toEqual(['page-1', 'fade', 'left', 'right', 'up', 'down']);
  expect(output.xml()).not.toContain('<p:transition');
  expect(output.xml('ppt/slides/slide2.xml')).toContain('p14:dur="275"><p:fade thruBlk="0"/>');
  for (const [i, dir] of ['l', 'r', 'u', 'd'].entries()) {
    const xml = output.xml(`ppt/slides/slide${i + 3}.xml`);
    expect(xml).toContain(`p14:dur="711"><p:push dir="${dir}"/>`);
    expect(xml).toContain(`<mc:Fallback><p:transition spd="slow"><p:push dir="${dir}"/>`);
  }
});

it('encodes the saved value format without applying additional number formatting from PPTX options', async () => {
  const deck = contractDeck([]);
  const source = { artifactId: 'saved-source', domain: 'analysis-notebook' };
  const content = { value: 1500 };
  const cited = insertSlideCitation(deck.slides[0].id, 'value-citation', {
    schemaVersion: 2,
    mode: 'fixed',
    source: { ...source, target: { kind: 'value', targetId: 'summary', metricId: 'metric' } },
    snapshot: {
      ...source,
      versionId: 'locked-v1',
      revision: 1,
      content,
      contentHash: await contentHash(content),
      dependencies: [],
    },
    presentation: {
      kind: 'value',
      value: 1500,
      format: { style: 'decimal', digits: 1, unit: '' },
    },
  }).apply(deck);
  const options = {
    ...contractOptions,
    format: { style: 'decimal', digits: 0, grouping: true, unit: '億' },
  };
  const plan = await prepare(cited, {}, options);
  const result = await encodeSlidePptx(plan, consent(plan));
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw Error('Output blocked');
  const xml = strFromU8(unzipSync(result.bytes)['ppt/slides/slide1.xml']);
  expect(xml).toContain('<a:t>1500.0</a:t>');
  expect(xml).not.toContain('1,500億');
});

it('embeds the fixed value and verified figure bytes with citations in speaker notes', async () => {
  const deck = contractDeck();
  const { id } = deck.slides[0];
  deck.slides[0].notes = 'Original speaker notes';
  const source = { artifactId: 'saved-source', domain: 'analysis-notebook' };
  const content = { value: 42 };
  const snapshot = {
    ...source,
    versionId: 'locked-v7',
    revision: 7,
    content,
    contentHash: await contentHash(content),
    dependencies: [],
  };
  const common = { schemaVersion: 3, mode: 'fixed', snapshot } as const;
  const figure: PptxFigureReference = {
    ...common,
    source: { ...source, target: { kind: 'figure', figureId: 'plot' } },
    presentation: { kind: 'figure', label: 'Saved plot' },
  };
  const cited = insertSlideCitation(id, 'plot-citation', figure).apply(
    insertSlideCitation(id, 'value-citation', {
      ...common,
      source: { ...source, target: { kind: 'value', targetId: 'summary', metricId: 'metric' } },
      presentation: {
        kind: 'value',
        value: 42,
        format: { style: 'decimal', digits: 1, unit: ' kg' },
      },
    }).apply(deck),
  );
  // Both citations name one retained version, stored once in the deck's table.
  expect(Object.keys(cited.liveSnapshots ?? {})).toHaveLength(1);
  const png = contractPng(4, 2);
  const resolveReferenceImage = vi.fn(async () => png);
  const resolveAsset = vi.fn();
  const plan = await prepare(cited, { resolveReferenceImage, resolveAsset });
  const output = await encoded(plan);
  expect(resolveReferenceImage).toHaveBeenCalledExactlyOnceWith(figure, undefined);
  expect(resolveAsset).not.toHaveBeenCalled();
  expect(output.xml()).toContain('<a:t>42.0 kg</a:t>');
  expect(output.xml()).toContain('<p:pic>');
  expect(output.xml()).not.toMatch(/引用|saved-source|locked-v7|e4f3ea/);
  const notes = output.xml('ppt/notesSlides/notesSlide1.xml');
  expect(notes).toContain('saved-source');
  expect(notes).toContain('locked-v7');
  expect(notes).toContain(snapshot.contentHash);
  expect(notes).not.toContain('Original speaker notes');
  expect(
    Object.entries(output.files).some(
      ([path, bytes]) => path.startsWith('ppt/media/') && Buffer.from(bytes).equals(png.bytes),
    ),
  ).toBe(true);

  const blocked = await prepare(cited, {
    resolveReferenceImage: async () => {
      throw Error('Saved version unavailable');
    },
  });
  expect(blocked.report.diagnostics).toContainEqual(
    expect.objectContaining({
      address: { domain: 'slide', slideId: id, elementId: 'plot-citation' },
      code: 'REFERENCE_IMAGE_UNAVAILABLE',
      severity: 'error',
      message: expect.stringContaining('Saved version unavailable'),
    }),
  );
  expect(await encodeSlidePptx(blocked, consent(blocked))).toMatchObject({ status: 'blocked' });
});
