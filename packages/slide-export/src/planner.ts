import { canonicalJson, clone, deepFreeze } from '@editor-platform/artifact-core';
import type { Bounds, Drawing, DrawingTextLayout } from '@editor-platform/editor-core';
import {
  checkExportAbort,
  exportAssetLimits,
  exportDiagnostic,
  ExportAdapterError,
  hashExportBytes,
  ownExportAsset,
  validFontProfile,
  type ExportDiagnostic,
  type ExportFontProfile,
  type SlideExportAddress,
} from '@editor-platform/export-core';
import type {
  PptxAdapters,
  PptxElement,
  PptxPage,
  PptxRasterResult,
  ResolvedPptxAsset,
  SlidePptxOptions,
  SlidePptxReport,
} from './types';
import { shapeRasterBounds } from './geometry';
/** Characters that XML 1.0 cannot carry in PPTX text or notes. */
export const hasXmlControlCharacter = (text: string) =>
  Array.from(text).some((c) => {
    const n = c.codePointAt(0)!;
    return (
      (n < 32 && ![9, 10, 13].includes(n)) ||
      (n >= 0xd800 && n <= 0xdfff) ||
      n === 0xfffe ||
      n === 0xffff
    );
  });
/** A fallback owns local paint only. The Office picture applies the outer transform once. */
function rasterDrawing(source: Drawing, font: ExportFontProfile | undefined) {
  const drawing = clone(source);
  drawing.rotation = 0;
  drawing.flipX = false;
  drawing.flipY = false;
  drawing.opacity = 1;
  if (font) {
    drawing.typography = { ...drawing.typography, fontFamily: font.family };
    drawing.runs = drawing.runs?.map((r) => ({
      ...r,
      style: { ...r.style, fontFamily: font.family },
    }));
  }
  return drawing;
}
/** Paint bounds including stroke outsets and expanded text overflow. */
function rasterBounds(drawing: Drawing, layout: DrawingTextLayout | undefined): Bounds {
  const b = shapeRasterBounds(drawing);
  const outset =
    drawing.kind === 'shape' ? (drawing.strokeWidth ?? 1) / 2 : drawing.kind === 'table' ? 0.5 : 0;
  const expand = drawing.typography?.overflow === 'expand' && layout;
  const top = expand ? Math.min(b.y, layout.startY) : b.y;
  const bottom = expand
    ? Math.max(b.y + b.height, layout.startY + layout.totalHeight)
    : b.y + b.height;
  return {
    x: b.x - outset,
    y: top - outset,
    width: b.width + outset * 2,
    height: bottom - top + outset * 2,
  };
}
/** The adapter's paint region; it must contain the requested bounds at scale 2. */
function rasterRegion(result: PptxRasterResult, bounds: Bounds) {
  if (result.mime !== 'image/png') throw new Error('Raster adapter must return PNG');
  const region = result.bounds ? clone(result.bounds) : bounds;
  if (
    ![region.x, region.y, region.width, region.height].every(Number.isFinite) ||
    region.width <= 0 ||
    region.height <= 0 ||
    region.x > bounds.x ||
    region.y > bounds.y ||
    region.x + region.width < bounds.x + bounds.width ||
    region.y + region.height < bounds.y + bounds.height
  )
    throw new Error('Raster adapter cannot crop the requested paint region');
  if (
    result.width !== Math.max(1, Math.ceil(region.width * 2)) ||
    result.height !== Math.max(1, Math.ceil(region.height * 2))
  )
    throw new Error('Raster dimensions do not match the requested region and scale');
  return region;
}
/** Mutable state of one PPTX plan: diagnostics, report rows, pages, owned assets and font. */
export class PptxPlanner {
  readonly diagnostics: ExportDiagnostic<SlideExportAddress>[] = [];
  readonly reportElements: SlidePptxReport['elements'] = [];
  readonly pages: PptxPage[] = [];
  readonly assets = new Map<string, ResolvedPptxAsset>();
  font: ExportFontProfile | undefined;
  private readonly diagnosticIds = new Set<string>();
  private readonly services: Pick<PptxAdapters, 'resolveFont' | 'resolveAsset' | 'rasterize'>;
  private assetBytes = 0;
  constructor(
    readonly settings: SlidePptxOptions,
    adapters: PptxAdapters,
    readonly signal: AbortSignal | undefined,
  ) {
    this.services = {
      resolveFont: adapters?.resolveFont?.bind(adapters),
      resolveAsset: adapters?.resolveAsset?.bind(adapters),
      rasterize: adapters?.rasterize?.bind(adapters),
    };
  }
  add(
    code: string,
    severity: ExportDiagnostic['severity'],
    message: string,
    address?: SlideExportAddress,
    effect?: ExportDiagnostic['effect'],
  ) {
    const d = exportDiagnostic(code, severity, message, address, effect);
    if (!this.diagnosticIds.has(d.id)) {
      this.diagnostics.push(d);
      this.diagnosticIds.add(d.id);
    }
  }
  hasDiagnostic(codes: readonly string[]) {
    return this.diagnostics.some((d) => codes.includes(d.code));
  }
  async resolveFont() {
    const { fontProfileId } = this.settings;
    if (!this.services.resolveFont) {
      this.add('ADAPTER_UNAVAILABLE', 'error', 'A verified font resolver is required');
      return;
    }
    try {
      const font = deepFreeze(clone(await this.services.resolveFont(fontProfileId, this.signal)));
      checkExportAbort(this.signal);
      if (!validFontProfile(font, fontProfileId)) {
        this.add(
          'FONT_INVALID',
          'error',
          'Font manifest is incomplete or belongs to another profile',
        );
        return;
      }
      this.font = font;
      this.add(
        'FONT_REFERENCED_NOT_EMBEDDED',
        'info',
        `Recipients need ${font.family} ${font.version}; fonts are not embedded`,
      );
      if (!font.verified)
        this.add(
          'FONT_UNVERIFIED',
          'warning',
          'Font rendering has not been verified',
          undefined,
          'appearance',
        );
    } catch {
      checkExportAbort(this.signal);
      this.add('FONT_UNAVAILABLE', 'error', 'The selected font profile could not be resolved');
    }
  }
  private async storeAsset(key: string, value: Parameters<typeof ownExportAsset>[0]) {
    const asset = ownExportAsset(value);
    if (this.assetBytes + asset.bytes.length > exportAssetLimits.totalBytes)
      throw new Error('Total image bytes exceed 64 MiB');
    const resolved = { ...asset, hash: await hashExportBytes(asset.bytes) };
    checkExportAbort(this.signal);
    this.assetBytes += resolved.bytes.length;
    if (this.assetBytes > exportAssetLimits.totalBytes)
      throw new Error('Total image bytes exceed 64 MiB');
    this.assets.set(key, resolved);
    return resolved;
  }
  async resolveAsset(source: string | undefined, address: SlideExportAddress) {
    if (!source) {
      this.add('ASSET_UNAVAILABLE', 'error', 'An image source is missing', address);
      return;
    }
    if (this.assets.has(`source:${source}`)) return this.assets.get(`source:${source}`);
    if (!this.services.resolveAsset) {
      this.add('ADAPTER_UNAVAILABLE', 'error', 'An image resolver is required', address);
      return;
    }
    let value;
    try {
      value = await this.services.resolveAsset(source, this.signal);
    } catch {
      checkExportAbort(this.signal);
      this.add('ASSET_UNAVAILABLE', 'error', 'Image resolution failed', address);
      return;
    }
    try {
      return await this.storeAsset(`source:${source}`, value);
    } catch {
      checkExportAbort(this.signal);
      this.add(
        'ASSET_INVALID',
        'error',
        'Image data, dimensions or byte limits are invalid',
        address,
      );
    }
  }
  /** Rejects the element, or replaces it with an element PNG when the options allow it. */
  async fallback(element: PptxElement, reason: string, sourceImage?: ResolvedPptxAsset) {
    if (this.settings.fallback === 'reject') {
      this.add('UNSUPPORTED_ELEMENT', 'error', reason, element.address);
      return;
    }
    if (!this.services.rasterize) {
      this.add(
        'ADAPTER_UNAVAILABLE',
        'error',
        'Element PNG conversion requires a raster adapter',
        element.address,
      );
      return;
    }
    try {
      await this.rasterize(element, reason, this.services.rasterize, sourceImage);
    } catch (error) {
      checkExportAbort(this.signal);
      if (error instanceof ExportAdapterError)
        this.add(error.code, 'error', error.message, element.address);
      else this.add('RASTER_FAILED', 'error', 'Element PNG rendering failed', element.address);
    }
  }
  private async rasterize(
    element: PptxElement,
    reason: string,
    rasterize: NonNullable<PptxAdapters['rasterize']>,
    sourceImage: ResolvedPptxAsset | undefined,
  ) {
    const key = `raster:${canonicalJson(element.address)}`;
    const drawing = rasterDrawing(element.drawing, this.font);
    const bounds = rasterBounds(drawing, element.textLayout);
    const result = await rasterize(
      {
        drawing,
        bounds: clone(bounds),
        scale: 2,
        ...(sourceImage ? { sourceImage: ownExportAsset(sourceImage) } : {}),
      },
      this.signal,
    );
    const region = rasterRegion(result, bounds);
    await this.storeAsset(key, result);
    element.imageKey = key;
    element.imagePlacement = { bounds: region, crop: { left: 0, right: 0, top: 0, bottom: 0 } };
    element.representation = 'png';
    if (element.drawing.kind === 'image')
      this.add(
        'IMAGE_CROP_BAKED',
        'warning',
        'The visible crop and fit are baked into this PNG; the original framing cannot be recovered',
        element.address,
        'editability',
      );
    this.add(
      'ELEMENT_RASTERIZED',
      'warning',
      `${reason}. This element, including its text, becomes an uneditable picture`,
      element.address,
      'editability',
    );
  }
}
