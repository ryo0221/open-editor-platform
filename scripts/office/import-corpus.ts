import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { clone } from '@editor-platform/artifact-core';
import { exportSlideSvg } from '@editor-platform/slide/model';
import { prepareSlideImport } from '@editor-platform/slide-import';
import { materializeOfficeImport } from '@editor-platform/office-import-core';
import { prepareOfficeFonts, type OfficeFontManifest } from '@editor-platform/office-adapters';
import { decodeNodeOfficeImage, nodeOfficeImagePng } from '@editor-platform/office-adapters/node';
import { createOfficeSvgRenderer } from '@editor-platform/office-adapters/raster';
import {
  captureSlideExportSnapshot,
  prepareSlidePptx,
  encodeSlidePptx,
} from '@editor-platform/slide-export';
import { createPptxRasterAdapter } from '@editor-platform/slide-export/raster';
import type { ExportFontProfile } from '@editor-platform/export-core';
const root = process.argv[2] ?? 'test-results-office-import';
await mkdir(root, { recursive: true });
const fontRoot = 'apps/playground/public/office-fonts/',
  manifest = JSON.parse(await readFile(fontRoot + 'manifest.json', 'utf8')) as OfficeFontManifest;
const fonts = await prepareOfficeFonts(
  manifest,
  await Promise.all(manifest.faces.map((f) => readFile(fontRoot + f.file))),
);
const wasm = await readFile('node_modules/@resvg/resvg-wasm/index_bg.wasm');
const render = await createOfficeSvgRenderer(wasm, fonts),
  rasterize = await createPptxRasterAdapter(wasm, fonts, nodeOfficeImagePng);
const input = new Uint8Array(
  await readFile(process.env.IMPORT_PPTX_INPUT ?? 'tests/fixtures/office/import/external.pptx'),
);
const exclusions: string[] = process.env.IMPORT_EXCLUSIONS
  ? JSON.parse(await readFile(process.env.IMPORT_EXCLUSIONS, 'utf8'))
  : ['ppt/slides/slide1.xml#/sld[1]/AlternateContent[1]'];
const plan = await prepareSlideImport(
  { bytes: input, format: 'pptx' },
  {
    unsupported: 'review-conversions',
    fontProfileId: 'noto-cjk-jp-2.004',
    pages: 'all',
    notes: 'exclude',
    includeHidden: false,
    exclude: exclusions,
  },
  'external-slide',
  { version: 'node-image-validator-1', decodeImage: decodeNodeOfficeImage },
);
await writeFile(`${root}/external-slide-import-report.json`, JSON.stringify(plan.report, null, 2));
const artifact = materializeOfficeImport(plan, {
  planHash: plan.report.planHash,
  acceptedDiagnosticIds: plan.report.diagnostics.filter((d) => d.requiresConsent).map((d) => d.id),
});
await writeFile(`${root}/external-slide.native.json`, JSON.stringify(artifact, null, 2));
const deck = artifact.draft.content;
for (const [i, page] of deck.slides.entries()) {
  const svg = exportSlideSvg(deck, page);
  await writeFile(`${root}/external-slide-${i + 1}.svg`, svg);
  await writeFile(
    `${root}/external-slide-${i + 1}.png`,
    (await render(svg, deck.width, deck.height)).bytes,
  );
}
const exported = await prepareSlidePptx(
  await captureSlideExportSnapshot(deck, {
    kind: 'saved-version',
    artifactId: artifact.id,
    versionId: 'imported',
  }),
  {
    pageIds: 'all',
    includeHiddenSlides: true,
    includeNotes: true,
    fontProfileId: manifest.id,
    fallback: 'element-png',
  },
  {
    resolveFont: async () => clone(fonts.profile) as ExportFontProfile,
    resolveAsset: async (source) =>
      decodeNodeOfficeImage(
        new Uint8Array(Buffer.from(source.slice(source.indexOf(',') + 1), 'base64')),
      ),
    rasterize,
  },
);
await writeFile(
  `${root}/external-slide-export-report.json`,
  JSON.stringify(exported.report, null, 2),
);
const result = await encodeSlidePptx(exported, {
  planHash: exported.report.planHash,
  acceptedDiagnosticIds: exported.report.diagnostics
    .filter((d) => d.requiresAcceptance)
    .map((d) => d.id),
});
if (result.status !== 'ok') throw Error('Imported slide export blocked: ' + JSON.stringify(result));
await writeFile(`${root}/external-slide.pptx`, result.bytes);
console.log(
  JSON.stringify(
    {
      sourceHash: plan.report.sourceHash,
      planHash: plan.report.planHash,
      objects: deck.slides.map((s) => s.objects.length),
      diagnostics: plan.report.diagnostics.map((d) => ({
        code: d.code,
        disposition: d.disposition,
      })),
      exportBytes: result.bytes.length,
    },
    null,
    2,
  ),
);
