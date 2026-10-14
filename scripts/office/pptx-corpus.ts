import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { drawingSvg } from '@editor-platform/editor-core';
import {
  isDeck,
  slideDrawing,
  slidePaintOrder,
  type SlideContent,
} from '@editor-platform/slide/model';
import {
  captureSlideExportSnapshot,
  prepareSlidePptx,
  encodeSlidePptx,
  type SlidePptxOptions,
} from '@editor-platform/slide-export';
import { createPptxRasterAdapter } from '@editor-platform/slide-export/raster';
import { prepareOfficeFonts, imageDataUri } from '@editor-platform/office-adapters';
import { decodeNodeOfficeImage, nodeOfficeImagePng } from '@editor-platform/office-adapters/node';
import { createOfficeSvgRenderer } from '@editor-platform/office-adapters/raster';
import { pptxGoldenDeck } from '../../tests/fixtures/office/pptx';
import type { ExportFontProfile } from '@editor-platform/export-core';
import type { OfficeFontManifest } from '@editor-platform/office-adapters';

const root = process.argv[2] ?? 'test-results-office';
await mkdir(root, { recursive: true });
const fontRoot = 'apps/playground/public/office-fonts/';
const manifest = JSON.parse(
  await readFile(fontRoot + 'manifest.json', 'utf8'),
) as OfficeFontManifest;
const fonts = await prepareOfficeFonts(
  manifest,
  await Promise.all(manifest.faces.map((f) => readFile(fontRoot + f.file))),
);
const wasm = await readFile('node_modules/@resvg/resvg-wasm/index_bg.wasm');
const rasterize = await createPptxRasterAdapter(wasm, fonts, nodeOfficeImagePng);
const render = await createOfficeSvgRenderer(wasm, fonts);
const images = {} as Record<'png' | 'jpeg' | 'gif' | 'webp', string>;
for (const format of ['png', 'jpeg', 'gif', 'webp'] as const) {
  const asset = await decodeNodeOfficeImage(
    new Uint8Array(await readFile(`tests/fixtures/office/images/quadrants.${format}`)),
  );
  images[format] = imageDataUri(asset);
}
const practical = JSON.parse(await readFile('tests/fixtures/office/practical/slide.native.json', 'utf8')).draft
  .content as SlideContent;
const golden = pptxGoldenDeck(images);
const portrait = structuredClone(golden);
portrait.width = 720;
portrait.height = 960;
portrait.slides = [structuredClone(golden.slides[0]), structuredClone(golden.slides[0])];
portrait.slides[0].id = 'G08-portrait';
portrait.slides[1].id = 'G08-hidden';
portrait.slides[1].hidden = true;
portrait.slides[0].objects = portrait.slides[0].objects.slice(0, 3);
for (const o of portrait.slides[0].objects) o.bounds.width = Math.min(o.bounds.width, 640);
portrait.slides[1].objects = structuredClone(portrait.slides[0].objects);
portrait.slides[0].backgroundImage = images.png;
portrait.slides[0].objects[1].fill = '#000000';
const cases = [
  { name: 'golden', deck: golden },
  { name: 'practical-issue6', deck: practical },
  { name: 'portrait-notes', deck: portrait },
];
const timings = [];
for (const { name, deck } of cases) {
  if (!isDeck(deck)) throw Error(`Invalid native fixture: ${name}`);
  const before = JSON.stringify(deck),
    started = performance.now();
  const options: SlidePptxOptions = {
    pageIds: 'all',
    includeHiddenSlides: name === 'portrait-notes',
    includeNotes: name === 'portrait-notes',
    fontProfileId: manifest.id,
    fallback: 'element-png',
  };
  const resolveAsset = async (source: string) => {
    if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(source))
      throw Error('Corpus images must be embedded');
    return decodeNodeOfficeImage(
      new Uint8Array(Buffer.from(source.slice(source.indexOf(',') + 1), 'base64')),
    );
  };
  const plan = await prepareSlidePptx(
    await captureSlideExportSnapshot(deck, {
      kind: 'saved-version',
      artifactId: 'PRIVATE_ARTIFACT_SENTINEL',
      versionId: 'PRIVATE_VERSION_SENTINEL',
    }),
    options,
    {
      resolveFont: async () => structuredClone(fonts.profile) as ExportFontProfile,
      resolveAsset,
      rasterize,
    },
  );
  await writeFile(path.join(root, `${name}.preflight.json`), JSON.stringify(plan.report, null, 2));
  const errors = plan.report.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length) throw Error(JSON.stringify(errors));
  const result = await encodeSlidePptx(plan, {
    planHash: plan.report.planHash,
    acceptedDiagnosticIds: plan.report.diagnostics
      .filter((d) => d.requiresAcceptance)
      .map((d) => d.id),
  });
  if (result.status !== 'ok') throw Error(JSON.stringify(result));
  if (before !== JSON.stringify(deck)) throw Error('Export changed the fixture');
  await writeFile(path.join(root, `${name}.pptx`), result.bytes);
  await writeFile(path.join(root, `${name}.report.json`), JSON.stringify(result.report, null, 2));
  await writeFile(path.join(root, `${name}.native.json`), JSON.stringify(deck, null, 2));
  for (const [i, slide] of deck.slides.entries()) {
    const drawings = slidePaintOrder(slide).map(slideDrawing);
    if (slide.backgroundImage)
      drawings.unshift({
        id: 'background',
        kind: 'image',
        text: '',
        fill: 'none',
        src: slide.backgroundImage,
        bounds: { x: 0, y: 0, width: deck.width, height: deck.height },
        imageFit: 'fill',
      });
    for (const d of drawings) {
      d.typography = { ...d.typography, fontFamily: fonts.profile.family };
      d.runs = d.runs?.map((r) => ({
        ...r,
        style: { ...r.style, fontFamily: fonts.profile.family },
      }));
      if (d.kind === 'image' && d.src)
        d.src = imageDataUri(await nodeOfficeImagePng(await resolveAsset(d.src)));
    }
    const svg = drawingSvg(
      drawings,
      { x: 0, y: 0, width: deck.width, height: deck.height },
      slide.background,
    );
    const png = render(svg, deck.width, deck.height);
    await writeFile(path.join(root, `${name}-reference-${i + 1}.svg`), svg);
    await writeFile(path.join(root, `${name}-reference-${i + 1}.png`), png.bytes);
  }
  timings.push({
    name,
    pages: deck.slides.length,
    bytes: result.bytes.length,
    sha256: createHash('sha256').update(result.bytes).digest('hex'),
    elapsedMs: performance.now() - started,
    counts: result.report.counts,
  });
  console.log(JSON.stringify(timings.at(-1)));
}
await writeFile(
  path.join(root, 'generation.json'),
  JSON.stringify(
    {
      node: process.version,
      font: { id: manifest.id, version: manifest.version, faces: manifest.faces },
      samples: timings,
      note: 'Includes reference rendering; this is not a G14 performance measurement',
    },
    null,
    2,
  ),
);
