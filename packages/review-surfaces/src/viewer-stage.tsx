import { useRef, type PointerEvent, type ReactNode, type RefObject } from 'react';
import type { PDFDocumentProxy, PageViewport } from 'pdfjs-dist';
import type { Bounds, Region } from '@editor-platform/editor-core';
import { PdfTextLayer, type usePdfTextIndex } from './pdf-text';
import { PdfCanvas } from './pdf';
import { VirtualRows } from './virtual';
import {
  hasExtractableText,
  lineSelected,
  lineSelection,
  type FileLine,
  type FileRegionOverlay,
  type FileTool,
  type Size,
} from './viewer-utils';

export type RegionPointerEvents = {
  onPointerDown(e: PointerEvent<SVGSVGElement>): void;
  onPointerMove(e: PointerEvent<SVGSVGElement>): void;
  onPointerUp(e: PointerEvent<SVGSVGElement>): void;
  onPointerCancel(): void;
};

export function RegionOverlays({
  regions,
  active,
  renderedRect,
}: {
  regions: FileRegionOverlay[];
  active: Bounds | undefined;
  renderedRect(bounds: Bounds): Bounds;
}) {
  return (
    <>
      {regions.map((r) => (
        <rect
          key={r.id}
          {...renderedRect(r.bounds)}
          className={`ep-file-region ${r.resolved ? 'resolved' : ''}`}
          style={r.color ? { stroke: r.color } : undefined}
        >
          <title>{r.title}</title>
        </rect>
      ))}
      {active && (
        <rect
          {...renderedRect(active)}
          className="ep-file-region active"
          data-testid="selected-file-region"
        />
      )}
    </>
  );
}

export function PdfTextNotices({
  truncated,
  textIndex,
}: {
  truncated: boolean;
  textIndex: ReturnType<typeof usePdfTextIndex>;
}) {
  return (
    <>
      {truncated && (
        <p role="status" className="ep-muted">
          検索結果の一部を表示しています。各ページの先頭10,000件まで移動できます。検索語を絞り込んでください。
        </p>
      )}
      {textIndex.done && !textIndex.error && !hasExtractableText(textIndex.pages) && (
        <p role="status">
          このPDFには抽出できる文字がありません。領域選択は利用できます。OCRはHost拡張で、ここでは提供していません。
        </p>
      )}
      {textIndex.error && <p role="alert">文字の抽出に失敗しました: {textIndex.error}</p>}
    </>
  );
}

export function AssetScroller({
  scrollerRef,
  tool,
  children,
}: {
  scrollerRef: RefObject<HTMLDivElement | null>;
  tool: FileTool;
  children: ReactNode;
}) {
  const pan = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined);
  return (
    <div
      ref={scrollerRef}
      className={`ep-asset-scroll ${tool}`}
      onPointerDown={(e) => {
        if (tool !== 'pan') return;
        pan.current = {
          x: e.clientX,
          y: e.clientY,
          left: e.currentTarget.scrollLeft,
          top: e.currentTarget.scrollTop,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!pan.current) return;
        e.currentTarget.scrollLeft = pan.current.left - e.clientX + pan.current.x;
        e.currentTarget.scrollTop = pan.current.top - e.clientY + pan.current.y;
      }}
      onPointerUp={() => {
        pan.current = undefined;
      }}
      onPointerCancel={() => {
        pan.current = undefined;
      }}
    >
      {children}
    </div>
  );
}

export function PdfPageView({
  pdf,
  page,
  zoom,
  rotation,
  viewport,
  tool,
  query,
  selectedMatch,
  regionEvents,
  overlays,
  onViewport,
  onError,
}: {
  pdf: PDFDocumentProxy;
  page: number;
  zoom: number;
  rotation: number;
  viewport: PageViewport | undefined;
  tool: FileTool;
  query: string;
  selectedMatch: { page: number; offset: number } | undefined;
  regionEvents: RegionPointerEvents;
  overlays: ReactNode;
  onViewport(viewport: PageViewport, natural: Size): void;
  onError(error: string): void;
}) {
  return (
    <div
      className="ep-pdf-page"
      data-page={page}
      style={{ width: viewport?.width, height: viewport?.height }}
    >
      <PdfCanvas
        pdf={pdf}
        page={page}
        zoom={zoom}
        rotation={rotation}
        onViewport={onViewport}
        onError={onError}
      />
      {viewport && tool === 'text' && (
        <PdfTextLayer
          pdf={pdf}
          page={page}
          viewport={viewport}
          query={query}
          selectedOffset={selectedMatch?.page === page ? selectedMatch.offset : undefined}
        />
      )}
      {viewport && tool !== 'text' && (
        <svg
          className="ep-pdf-overlay"
          aria-label={`Select PDF region on page ${page}`}
          width={viewport.width}
          height={viewport.height}
          viewBox={`0 0 ${viewport.width} ${viewport.height}`}
          {...regionEvents}
        >
          {overlays}
        </svg>
      )}
    </div>
  );
}

export function ImagePageView({
  src,
  shownSize,
  imageSize,
  zoom,
  transform,
  imageGroupRef,
  regionEvents,
  overlays,
}: {
  src: string;
  shownSize: Size;
  imageSize: Size;
  zoom: number;
  transform: string | undefined;
  imageGroupRef: RefObject<SVGGElement | null>;
  regionEvents: RegionPointerEvents;
  overlays: ReactNode;
}) {
  return (
    <svg
      aria-label="Select image region"
      className="ep-image-page"
      width={shownSize.width * zoom}
      height={shownSize.height * zoom}
      viewBox={`0 0 ${shownSize.width} ${shownSize.height}`}
      {...regionEvents}
    >
      <g ref={imageGroupRef} transform={transform}>
        <image href={src} width={imageSize.width} height={imageSize.height} />
        <g>{overlays}</g>
      </g>
    </svg>
  );
}

/** Marks each case-insensitive match of the search in the shown text. */
export function SearchMarks({ text, query }: { text: string; query: string }) {
  const lower = text.toLocaleLowerCase(),
    needle = query.toLocaleLowerCase();
  // Case folding that changes length would misplace marks, so such text stays unmarked.
  if (!needle || lower.length !== text.length || !lower.includes(needle)) return <>{text}</>;
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, from)) {
    parts.push(text.slice(from, at), <mark key={at}>{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

export function TextFileView({
  lines,
  wrap,
  query,
  targetLine,
  region,
  onChoose,
}: {
  lines: FileLine[];
  wrap: boolean;
  query: string;
  targetLine: number | undefined;
  region: Region | undefined;
  onChoose(region: Region): void;
}) {
  return (
    <div className={`ep-text-view ${wrap ? 'wrap' : ''}`}>
      <VirtualRows
        rows={lines}
        rowKey={(l) => String(l.index)}
        focusIndex={targetLine}
        label="Text file"
        render={(line) => (
          <button
            className={`ep-file-line ${lineSelected(region, line.index + 1) ? 'selected' : ''}`}
            aria-label={`File line ${line.index + 1}`}
            onClick={(e) => onChoose(lineSelection(region, line.index + 1, e.shiftKey))}
          >
            <span className="ep-line-number">{line.index + 1}</span>
            <code>{line.text ? <SearchMarks text={line.text} query={query} /> : ' '}</code>
          </button>
        )}
      />
    </div>
  );
}
