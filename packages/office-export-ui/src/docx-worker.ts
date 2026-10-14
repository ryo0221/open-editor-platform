import {
  captureDocumentExportSnapshot,
  prepareDocumentDocx,
  encodeDocumentDocx,
  documentDocxCapabilities,
  type DocumentDocxPlan,
} from '@editor-platform/document-export';
import { prepareOfficeFonts, type OfficeFontManifest } from '@editor-platform/office-adapters';
import { fetchOfficeImage, browserOfficeImagePng } from '@editor-platform/office-adapters/browser';
import { createOfficeSvgRenderer } from '@editor-platform/office-adapters/raster';
import type { ExportFontProfile } from '@editor-platform/export-core';
import wasmUrl from '@resvg/resvg-wasm/index_bg.wasm?url';
import type { DocxJobRequest, DocxJobResponse, MermaidSvg } from './docx-protocol';

async function loadFonts(url: string) {
  const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Error('The fixed Office font manifest could not be loaded');
  const manifest = (await response.json()) as OfficeFontManifest;
  if (!Array.isArray(manifest.faces) || manifest.faces.length !== 2)
    throw Error('Invalid Office font manifest');
  const files = await Promise.all(
    manifest.faces.map(async (face) => {
      const response = await fetch(new URL(face.file, url), {
        credentials: 'omit',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok || !response.body)
        throw Error('The fixed Office font file could not be loaded');
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.length;
          if (length > 24 * 1024 * 1024) throw Error('Office font file is too large');
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel();
      }
      const bytes = new Uint8Array(length);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      return bytes;
    }),
  );
  return { manifest, files, fonts: await prepareOfficeFonts(manifest, files) };
}
let plan: DocumentDocxPlan | undefined;
const fonts = new Map<string, ReturnType<typeof loadFonts>>();
function font(url: string) {
  let result = fonts.get(url);
  if (!result) {
    result = loadFonts(url).catch((e) => {
      fonts.delete(url);
      throw e;
    });
    fonts.set(url, result);
  }
  return result;
}
let renderSequence = 0;
const renderPending = new Map<
  number,
  { resolve(result: MermaidSvg): void; reject(error: Error): void }
>();
const send = (message: DocxJobResponse, transfer: Transferable[] = []) =>
  postMessage(message, { transfer });
let raster: { url: string; value: ReturnType<typeof createOfficeSvgRenderer> } | undefined;
onmessage = async ({ data }: MessageEvent<DocxJobRequest>) => {
  if (data.action === 'mermaid-result') {
    const pending = renderPending.get(data.renderId);
    if (!pending) return;
    renderPending.delete(data.renderId);
    if (data.result) pending.resolve(data.result);
    else pending.reject(Error(data.message ?? 'Mermaid rendering failed'));
    return;
  }
  try {
    if (data.action === 'prepare') {
      plan = undefined;
      const snapshot = captureDocumentExportSnapshot(data.content, data.basis);
      plan = await prepareDocumentDocx(await snapshot, data.options, {
        resolveFont: async (id) => {
          const bundle = await font(
            id === documentDocxCapabilities.codeFontProfileId
              ? data.codeFontManifestUrl
              : data.fontManifestUrl,
          );
          return structuredClone(bundle.fonts.profile) as ExportFontProfile;
        },
        resolveAsset: fetchOfficeImage,
        imagePng: browserOfficeImagePng,
        renderMermaid: async (source) => {
          const bundle = await font(data.fontManifestUrl),
            renderId = ++renderSequence;
          const drawing = await new Promise<MermaidSvg>((resolve, reject) => {
            renderPending.set(renderId, { resolve, reject });
            // Structured copies: the frame cannot mutate the worker's fixed font bundle.
            send({
              id: data.id,
              status: 'render-mermaid',
              renderId,
              source,
              manifest: bundle.manifest,
              files: bundle.files,
            });
          });
          if (!raster || raster.url !== data.fontManifestUrl)
            raster = {
              url: data.fontManifestUrl,
              value: (async () => {
                const response = await fetch(wasmUrl, {
                  credentials: 'omit',
                  signal: AbortSignal.timeout(10000),
                });
                if (!response.ok) throw Error('The Office diagram renderer could not be loaded');
                return createOfficeSvgRenderer(
                  new Uint8Array(await response.arrayBuffer()),
                  bundle.fonts,
                );
              })().catch((error: unknown) => {
                raster = undefined;
                throw error;
              }),
            };
          return (await raster.value)(drawing.svg, drawing.width, drawing.height);
        },
      });
      send({ id: data.id, status: 'prepared', report: plan.report });
    } else {
      if (!plan) throw Error('Prepare the export again before downloading');
      const result = await encodeDocumentDocx(plan, data.consent);
      send(
        { id: data.id, status: 'encoded', result },
        result.status === 'ok' ? [result.bytes.buffer as ArrayBuffer] : [],
      );
    }
  } catch (error) {
    send({
      id: data.id,
      status: 'failed',
      message: error instanceof Error ? error.message : 'Office export failed',
    });
  }
};
