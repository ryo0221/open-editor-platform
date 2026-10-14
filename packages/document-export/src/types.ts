import type {
  DocumentContent,
  InlineSpan,
  DocumentTextStyle,
} from '@editor-platform/document/model';
import type {
  ExportAsset,
  ExportAssetAdapter,
  ExportFontAdapter,
  ExportFontProfile,
  ExportReport,
  ExportSnapshot,
  ReadonlyTree,
  DocumentExportAddress,
  ExportResult,
} from '@editor-platform/export-core';

export type DocumentExportSnapshot = ExportSnapshot<DocumentContent>;
export interface DocumentDocxOptions {
  fontProfileId: string;
  styleProfileId: 'document-ja-1';
  mermaid: 'reject' | 'image' | 'source';
  previewBlocks: 'reject' | 'source';
}
export interface DocxAdapters extends Partial<ExportAssetAdapter>, Partial<ExportFontAdapter> {
  /** Convert owned GIF/WebP bytes to a static PNG, without looking up the source again. */
  imagePng?(asset: ExportAsset, signal?: AbortSignal): Promise<ExportAsset>;
  /** Trusted renderer validates Mermaid syntax and returns a portable, owned element picture. */
  renderMermaid?(source: string, signal?: AbortSignal): Promise<ExportAsset>;
}
export type DocxRepresentation = 'native' | 'static-checkbox' | 'source' | 'png';
export interface DocumentDocxReport extends ExportReport<DocumentExportAddress> {
  styleProfileId: string;
  blocks: {
    address: DocumentExportAddress;
    representation: DocxRepresentation;
    outputPartNames: string[];
  }[];
  details: {
    address: DocumentExportAddress;
    kind: 'paragraph' | 'cell' | 'image';
    outputPartNames: string[];
  }[];
  counts: { native: number; converted: number; rasterized: number };
}
declare const planBrand: unique symbol;
export interface DocumentDocxPlan {
  readonly [planBrand]: true;
  readonly report: ReadonlyTree<DocumentDocxReport>;
}
export type DocumentDocxResult = ExportResult<DocumentDocxReport>;
export const documentDocxCapabilities = Object.freeze({
  blocks: 2000,
  textCharacters: 1_000_000,
  logicalCells: 50_000,
  maxListLevel: 8,
  styles: Object.freeze(['document-ja-1']),
  codeFontProfileId: 'noto-sans-mono-cjk-jp-2.004',
});

// Private Document flow projection. No canvas/PPTX types, persisted schema or Office library types.
export interface DocxParagraph {
  kind: 'paragraph';
  address: DocumentExportAddress;
  runs: InlineSpan[];
  style?: DocumentTextStyle;
  heading?: number;
  align?: 'left' | 'center' | 'right' | 'justify';
  indent: number;
  role: 'body' | 'code' | 'caption';
  numbering?: { reference: string; level: number };
}
export interface DocxPicture {
  kind: 'image';
  address: DocumentExportAddress;
  assetKey: string;
  width: number;
  height: number;
  alt: string;
}
export interface DocxTable {
  kind: 'table';
  address: DocumentExportAddress;
  widths: number[];
  rows: {
    header: boolean;
    cells: {
      address: DocumentExportAddress;
      column: number;
      columns: number;
      merge?: 'restart' | 'continue';
      paragraphs: DocxParagraph[];
      header: boolean;
    }[];
  }[];
}
export type DocxNode = DocxParagraph | DocxPicture | DocxTable;
export interface OwnedDocxPlan {
  report: ReadonlyTree<DocumentDocxReport>;
  nodes: DocxNode[];
  font?: ExportFontProfile;
  codeFont?: ExportFontProfile;
  numbering: { reference: string; level: number; kind: 'bullet' | 'number'; start?: number }[];
  page: { width: number; height: number; margin: number; landscape: boolean };
  assets: Map<string, ExportAsset & { hash: string }>;
}
