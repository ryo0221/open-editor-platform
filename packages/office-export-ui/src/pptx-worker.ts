import {
  captureSlideExportSnapshot,
  prepareSlidePptx,
  encodeSlidePptx,
  type SlidePptxPlan,
} from '@editor-platform/slide-export';
import { createPptxRasterAdapter } from '@editor-platform/slide-export/raster';
import { prepareOfficeFonts, type OfficeFontManifest } from '@editor-platform/office-adapters';
import { fetchOfficeImage, browserOfficeImagePng } from '@editor-platform/office-adapters/browser';
import wasmUrl from '@resvg/resvg-wasm/index_bg.wasm?url';
import type { ExportFontProfile } from '@editor-platform/export-core';
import type { PptxJobRequest, PptxJobResponse } from './pptx-protocol';

let plan: SlidePptxPlan | undefined;
async function loadAdapters(url: string) {
  const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw Error('The fixed Office font manifest could not be loaded');
  const manifest = (await response.json()) as OfficeFontManifest;
  if (!Array.isArray(manifest.faces) || manifest.faces.length !== 2)
    throw Error('Invalid Office font manifest');
  const files = await Promise.all(
    manifest.faces.map(async (face) => {
      // Manifest is Host configuration, not document content. Still enforce bounded files.
      const font = await fetch(new URL(face.file, url), {
        credentials: 'omit',
        signal: AbortSignal.timeout(10_000),
      });
      if (!font.ok) throw Error('The fixed Office font file could not be loaded');
      const bytes = new Uint8Array(await font.arrayBuffer());
      if (bytes.length > 24 * 1024 * 1024) throw Error('Office font file is too large');
      return bytes;
    }),
  );
  const fonts = await prepareOfficeFonts(manifest, files);
  let raster: ReturnType<typeof createPptxRasterAdapter> | undefined;
  return {
    resolveFont: async () => structuredClone(fonts.profile) as ExportFontProfile,
    resolveAsset: fetchOfficeImage,
    rasterize: async (...args: Parameters<Awaited<ReturnType<typeof createPptxRasterAdapter>>>) => {
      raster ??= (async () => {
        const response = await fetch(wasmUrl, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw Error('The Office image renderer could not be loaded');
        return createPptxRasterAdapter(
          new Uint8Array(await response.arrayBuffer()),
          fonts,
          browserOfficeImagePng,
        );
      })();
      try {
        return await (
          await raster
        )(...args);
      } catch (e) {
        raster = undefined;
        throw e;
      }
    },
  };
}
let adapters: { url: string; value: ReturnType<typeof loadAdapters> } | undefined;
const send = (message: PptxJobResponse, transfer: Transferable[] = []) =>
  postMessage(message, { transfer });
onmessage = async ({ data }: MessageEvent<PptxJobRequest>) => {
  try {
    if (data.action === 'prepare') {
      plan = undefined;
      const snapshot = captureSlideExportSnapshot(data.content, data.basis);
      if (!adapters || adapters.url !== data.fontManifestUrl)
        adapters = { url: data.fontManifestUrl, value: loadAdapters(data.fontManifestUrl) };
      plan = await prepareSlidePptx(await snapshot, data.options, await adapters.value);
      send({ id: data.id, status: 'prepared', report: plan.report });
    } else {
      if (!plan) throw Error('Prepare the export again before downloading');
      const result = await encodeSlidePptx(plan, data.consent);
      send(
        { id: data.id, status: 'encoded', result },
        result.status === 'ok' ? [result.bytes.buffer as ArrayBuffer] : [],
      );
    }
  } catch (error) {
    adapters = undefined;
    send({
      id: data.id,
      status: 'failed',
      message: error instanceof Error ? error.message : 'Office export failed',
    });
  }
};
