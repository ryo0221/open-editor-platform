import { readFile } from 'node:fs/promises';
import {
  captureSlideExportSnapshot,
  prepareSlidePptx,
  encodeSlidePptx,
  type SlidePptxOptions,
} from '@editor-platform/slide-export';
import { createPptxRasterAdapter } from '@editor-platform/slide-export/raster';
import { prepareOfficeFonts, type OfficeFontManifest } from '@editor-platform/office-adapters';
import { decodeNodeOfficeImage, nodeOfficeImagePng } from '@editor-platform/office-adapters/node';
import type { CaptureBasis, ExportFontProfile } from '@editor-platform/export-core';
import type { SlideContent } from '@editor-platform/slide/model';

export async function nodePptx(
  content: SlideContent,
  basis: CaptureBasis,
  options: SlidePptxOptions,
) {
  const snapshot = captureSlideExportSnapshot(content, basis);
  const root = 'apps/playground/public/office-fonts/';
  const manifest = JSON.parse(await readFile(root + 'manifest.json', 'utf8')) as OfficeFontManifest;
  const fonts = await prepareOfficeFonts(
    manifest,
    await Promise.all(manifest.faces.map((f) => readFile(root + f.file))),
  );
  const rasterize = await createPptxRasterAdapter(
    new Uint8Array(await readFile('node_modules/@resvg/resvg-wasm/index_bg.wasm')),
    fonts,
    nodeOfficeImagePng,
  );
  const plan = await prepareSlidePptx(await snapshot, options, {
    resolveFont: async () => structuredClone(fonts.profile) as ExportFontProfile,
    resolveAsset: async (source) => {
      if (!source.startsWith('data:'))
        throw Error('Fixture resolver accepts owned data images only');
      return decodeNodeOfficeImage(new Uint8Array(Buffer.from(source.split(',')[1], 'base64')));
    },
    rasterize,
  });
  const result = await encodeSlidePptx(plan, {
    planHash: plan.report.planHash,
    acceptedDiagnosticIds: plan.report.diagnostics
      .filter((d) => d.requiresAcceptance)
      .map((d) => d.id),
  });
  if (result.status !== 'ok') throw Error(JSON.stringify(result));
  return result;
}
