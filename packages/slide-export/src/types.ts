import type { Bounds, Drawing, DrawingTextLayout } from '@editor-platform/editor-core';
import type { SlideContent } from '@editor-platform/slide/model';
import type { PptxImagePlacement } from './geometry';
import type {
  ExportAsset,
  ExportAssetAdapter,
  ExportFontAdapter,
  ExportFontProfile,
  ExportReport,
  ExportSnapshot,
  ReadonlyTree,
  SlideExportAddress,
  ExportConsent,
  ExportResult,
} from '@editor-platform/export-core';

export type SlideExportSnapshot = ExportSnapshot<SlideContent>;
export interface SlidePptxOptions {
  pageIds: 'all' | readonly string[];
  includeHiddenSlides: boolean;
  includeNotes: boolean;
  fontProfileId: string;
  fallback: 'reject' | 'element-png';
}
export interface PptxRasterRequest {
  drawing: Drawing;
  bounds: Bounds;
  scale: number;
  /** An isolated copy of the resolved image, for static GIF/WebP conversion. */
  sourceImage?: ExportAsset;
}
export interface PptxAdapters extends Partial<ExportAssetAdapter>, Partial<ExportFontAdapter> {
  rasterize?(request: PptxRasterRequest, signal?: AbortSignal): Promise<PptxRasterResult>;
}
export interface PptxRasterResult extends ExportAsset {
  /** Optional measured paint region. It must contain the requested region, never crop it. */
  bounds?: Bounds;
}
export type PptxRepresentation = 'native' | 'native-approximation' | 'png' | 'omitted';
export interface SlidePptxReport extends ExportReport<SlideExportAddress> {
  selectedPageIds: string[];
  elements: {
    address: SlideExportAddress;
    representation: PptxRepresentation;
    outputPartNames: string[];
    /** Groups have a mapping but do not double-count their independently painted children. */
    counted: boolean;
  }[];
  counts: { native: number; approximated: number; rasterized: number; omitted: number };
}
declare const planBrand: unique symbol;
export interface SlidePptxPlan {
  readonly [planBrand]: true;
  readonly report: ReadonlyTree<SlidePptxReport>;
}
export type SlidePptxResult = ExportResult<SlidePptxReport>;
export type SlidePptxEncoder = (
  plan: SlidePptxPlan,
  consent: ExportConsent,
  signal?: AbortSignal,
) => Promise<SlidePptxResult>;
export const slidePptxCapabilities = Object.freeze({
  slides: 100,
  objects: 10_000,
  minPageSide: 100,
  maxPageSide: 3840,
  nativeTable: 'unmerged-axis-aligned-opaque',
  transformedTable: 'element-png-or-reject',
  translucentTable: 'element-png-or-reject',
  mirroredText: 'element-png-or-reject',
  nativeShapes: Object.freeze([
    'rectangle',
    'rounded-rectangle',
    'ellipse',
    'triangle',
    'diamond',
    'line',
    'arrow',
    'double-arrow',
    'arrow-right',
    'arrow-left',
    'arrow-up',
    'arrow-down',
    'arrow-both',
  ] as const),
});
/** Private encoder input. None of these mutable owned bytes appear on the public handle. */
export interface ResolvedPptxAsset extends ExportAsset {
  hash: string;
}
export interface PptxElement {
  address: SlideExportAddress;
  drawing: Drawing;
  representation: PptxRepresentation;
  textLayout?: DrawingTextLayout;
  imageKey?: string;
  imagePlacement?: PptxImagePlacement;
  tableCells?: {
    row: number;
    col: number;
    bounds: Bounds;
    layout: DrawingTextLayout;
    text: string;
  }[];
}
export interface PptxPage {
  id: string;
  background: string;
  notes?: string;
  elements: PptxElement[];
}
export interface OwnedPptxPlan {
  report: ReadonlyTree<SlidePptxReport>;
  width: number;
  height: number;
  options: SlidePptxOptions;
  pages: PptxPage[];
  font?: ExportFontProfile;
  assets: Map<string, ResolvedPptxAsset>;
}
