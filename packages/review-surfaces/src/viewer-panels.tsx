import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Annotation, Bounds, Region } from '@editor-platform/editor-core';
import type { FileContent } from './model';
import { PdfThumbnail } from './pdf';
import {
  annotationStatus,
  boundsSummary,
  downloadOriginal,
  isAnchoredTo,
  regionLabel,
  type FileLine,
  type Size,
} from './viewer-utils';

export function PdfPageNavigator({
  pdf,
  page,
  onPage,
}: {
  pdf: PDFDocumentProxy | undefined;
  page: number;
  onPage(page: number): void;
}) {
  return (
    <nav aria-label="PDF pages">
      {pdf ? (
        Array.from({ length: pdf.numPages }, (_, i) => (
          <PdfThumbnail
            key={i}
            pdf={pdf}
            page={i + 1}
            selected={i + 1 === page}
            onClick={() => onPage(i + 1)}
          />
        ))
      ) : (
        <p>Loading PDF pages…</p>
      )}
    </nav>
  );
}

export function TextFileNavigator({
  name,
  isImage,
  lines,
  matches,
  onLine,
}: {
  name: string;
  isImage: boolean;
  lines: FileLine[];
  matches: number[];
  onLine(index: number): void;
}) {
  return (
    <div className="ep-file-nav">
      <strong>{name}</strong>
      <p>
        {isImage
          ? 'Image coordinates use original pixels.'
          : `${lines.length.toLocaleString()} lines`}
      </p>
      {matches.slice(0, 100).map((i) => (
        <button key={i} onClick={() => onLine(i)}>
          Line {i + 1} · {lines[i].text.slice(0, 32)}
        </button>
      ))}
    </div>
  );
}

function AnnotationEntry({
  annotation: a,
  fileId,
  readOnly,
  region,
  onFocus,
  onRemapAnnotation,
}: {
  annotation: Annotation;
  fileId: string;
  readOnly: boolean;
  region: Region | undefined;
  onFocus(region: Region): void;
  onRemapAnnotation?(id: string, fileId: string, region: Region): void;
}) {
  return (
    <div>
      <button
        style={a.color ? { borderInlineStart: `3px solid ${a.color}` } : undefined}
        onClick={() => {
          const address = a.anchor.addresses.find((x) => x.elementId === fileId);
          if (!address) return;
          const r = address.region;
          if (r) onFocus(r);
        }}
      >
        {a.comments[0]?.body}
        {' ·'} {annotationStatus(a, fileId)}
      </button>
      {!isAnchoredTo(a, fileId) && (
        <button
          disabled={readOnly || !region || !onRemapAnnotation}
          onClick={() => {
            if (region) onRemapAnnotation?.(a.id, fileId, region);
          }}
        >
          Remap annotation to current selection
        </button>
      )}
    </div>
  );
}

export function FileInspector({
  content,
  isPdf,
  isImage,
  pdf,
  imageSize,
  region,
  active,
  annotations,
  readOnly,
  onFocusAnnotation,
  onRemapAnnotation,
}: {
  content: FileContent;
  isPdf: boolean;
  isImage: boolean;
  pdf: PDFDocumentProxy | undefined;
  imageSize: Size;
  region: Region | undefined;
  active: Bounds | undefined;
  annotations: Annotation[];
  readOnly: boolean;
  onFocusAnnotation(region: Region): void;
  onRemapAnnotation?(id: string, fileId: string, region: Region): void;
}) {
  return (
    <div className="ep-file-info">
      <h3>{content.name}</h3>
      <p>{content.mime}</p>
      <p>{content.size.toLocaleString()} bytes</p>
      {isPdf && pdf && <p>{pdf.numPages} pages</p>}
      {isImage && (
        <p>
          {imageSize.width} × {imageSize.height} pixels
        </p>
      )}
      <button onClick={() => downloadOriginal(content)}>Download original</button>
      <h3>Selection</h3>
      {region ? <p>{regionLabel(region)}</p> : <p>Select a range or region to anchor a comment.</p>}
      {active && <p>{boundsSummary(active)}</p>}
      <h3>Annotations</h3>
      {annotations.map((a) => (
        <AnnotationEntry
          key={a.id}
          annotation={a}
          fileId={content.id}
          readOnly={readOnly}
          region={region}
          onFocus={onFocusAnnotation}
          onRemapAnnotation={onRemapAnnotation}
        />
      ))}
    </div>
  );
}
