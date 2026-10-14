import { drawingSvg, layoutDrawingText } from '@editor-platform/editor-core';
import {
  checkExportAbort,
  ExportAdapterError,
  type ExportAsset,
} from '@editor-platform/export-core';
import { imageDataUri, type OfficeFonts } from '@editor-platform/office-adapters';
import { createOfficeSvgRenderer } from '@editor-platform/office-adapters/raster';
import type { PptxAdapters } from './types';

export async function createPptxRasterAdapter(
  wasm: Uint8Array,
  fonts: OfficeFonts,
  imagePng: (asset: ExportAsset, signal?: AbortSignal) => Promise<ExportAsset>,
): Promise<NonNullable<PptxAdapters['rasterize']>> {
  const render = await createOfficeSvgRenderer(wasm, fonts);
  return async (request, signal) => {
    checkExportAbort(signal);
    const drawing = structuredClone(request.drawing);
    const italic =
      drawing.kind === 'table'
        ? drawing.typography?.italic
        : (drawing.kind === 'text' || drawing.kind === 'shape') &&
          layoutDrawingText(drawing).lines.some((l) => l.runs.some((r) => r.style?.italic));
    if (italic)
      throw new ExportAdapterError(
        'RASTER_TEXT_STYLE_UNSUPPORTED',
        'The fixed Regular/Bold raster profile cannot synthesize italic. Keep this text native or supply an adapter with verified italic rendering.',
      );
    if (request.sourceImage)
      drawing.src = imageDataUri(await imagePng(request.sourceImage, signal));
    if (drawing.kind === 'image' && !request.sourceImage)
      throw Error('Missing resolved raster image');
    let bounds = { ...request.bounds };
    if (
      drawing.kind === 'chart' ||
      drawing.kind === 'table' ||
      drawing.typography?.overflow === 'expand'
    ) {
      const measured = render.measure(drawingSvg([drawing], bounds));
      if (measured) {
        const x = Math.min(bounds.x, measured.x),
          y = Math.min(bounds.y, measured.y);
        bounds = {
          x,
          y,
          width: Math.max(bounds.x + bounds.width, measured.x + measured.width) - x,
          height: Math.max(bounds.y + bounds.height, measured.y + measured.height) - y,
        };
      }
    }
    const width = Math.max(1, Math.ceil(bounds.width * request.scale));
    const height = Math.max(1, Math.ceil(bounds.height * request.scale));
    // Keep world viewBox coordinates, including text expansion and stroke outset.
    const svg = drawingSvg([drawing], bounds).replace(
      /<svg\b[^>]*>/,
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}" preserveAspectRatio="none">`,
    );
    return { ...render(svg, width, height, signal), bounds };
  };
}
