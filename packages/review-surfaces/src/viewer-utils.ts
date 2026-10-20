import type { PageViewport } from 'pdfjs-dist';
import { newId } from '@editor-platform/artifact-core';
import type { Annotation, Bounds, Region } from '@editor-platform/editor-core';
import { originalBytes, type FileContent } from './model';
import { decodeFileText, type FileTextEncoding } from './text-decode';
import type { PdfIndexedPage } from './pdf-text';

export type FileFit = 'page' | 'width' | 'actual';
export type FileViewSettings = { fit?: FileFit; zoom?: number; annotations?: boolean };
export type FileTool = 'pan' | 'region' | 'text';
export type Size = { width: number; height: number };
export type FileLine = { text: string; index: number };
export type FileRegionOverlay = {
  id: string;
  bounds: Bounds;
  title: string;
  resolved: boolean | undefined;
  color: string | undefined;
};

export function downloadOriginal(file: FileContent) {
  const url = URL.createObjectURL(new Blob([originalBytes(file)], { type: file.mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function clampZoom(value: number) {
  return Math.max(0.05, Math.min(4, value));
}

export function initialFitMode(viewSettings?: FileViewSettings) {
  return viewSettings?.fit === 'actual' ? undefined : (viewSettings?.fit ?? 'page');
}

export function settingsZoom(zoom: number | undefined) {
  return clampZoom(typeof zoom === 'number' && Number.isFinite(zoom) ? zoom : 1);
}

export function fitZoom(fitMode: 'page' | 'width', viewSize: Size, shownSize: Size) {
  return clampZoom(
    Math.min(
      (viewSize.width - 64) / shownSize.width,
      fitMode === 'page' ? (viewSize.height - 64) / shownSize.height : 4,
    ),
  );
}

export function shownFileSize(isPdf: boolean, natural: Size, imageSize: Size, rotation: number) {
  if (isPdf) return natural;
  return rotation % 180 ? { width: imageSize.height, height: imageSize.width } : imageSize;
}

export function imageTransform(rotation: number, imageSize: Size) {
  if (rotation === 90) return `translate(${imageSize.height} 0) rotate(90)`;
  if (rotation === 180) return `translate(${imageSize.width} ${imageSize.height}) rotate(180)`;
  if (rotation === 270) return `translate(0 ${imageSize.width}) rotate(270)`;
  return undefined;
}

export function fileLines(content: FileContent, isPdf: boolean, isImage: boolean): FileLine[] {
  return isPdf || isImage ? [] : content.data.split('\n').map((text, index) => ({ text, index }));
}

export function lineMatches(lines: FileLine[], query: string) {
  return query
    ? lines
        .filter((l) => l.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
        .map((l) => l.index)
    : [];
}

export function regionBounds(
  r: Region | undefined,
  context: { isImage: boolean; isPdf: boolean; imageSize: Size; page: number },
): Bounds | undefined {
  if (!r) return;
  const { imageSize } = context;
  if (context.isImage && r.type === 'canvas')
    return r.units === 'image-pixels'
      ? r
      : {
          x: r.x * imageSize.width,
          y: r.y * imageSize.height,
          width: r.width * imageSize.width,
          height: r.height * imageSize.height,
        };
  if (context.isPdf && r.type === 'page' && r.page === context.page && r.bounds) return r.bounds;
}

export function renderedBounds(b: Bounds, isPdf: boolean, viewport?: PageViewport): Bounds {
  if (!isPdf || !viewport) return b;
  const [x1, y1] = viewport.convertToViewportPoint(b.x, b.y);
  const [x2, y2] = viewport.convertToViewportPoint(b.x + b.width, b.y + b.height);
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x1 - x2),
    height: Math.abs(y1 - y2),
  };
}

export function annotationOverlays(
  annotations: Annotation[],
  fileId: string,
  rectangle: (region: Region | undefined) => Bounds | undefined,
): FileRegionOverlay[] {
  return annotations.flatMap((a) =>
    a.anchor.addresses
      .filter((x) => x.elementId === fileId)
      .flatMap((x) => {
        const b = rectangle(x.region);
        return b
          ? [
              {
                id: a.id,
                bounds: b,
                title: a.comments[0]?.body ?? '',
                resolved: a.resolved,
                color: a.color,
              },
            ]
          : [];
      }),
  );
}

export function dragBounds(
  start: { x: number; y: number },
  p: { x: number; y: number },
  minimum = 0,
): Bounds {
  return {
    x: Math.min(start.x, p.x),
    y: Math.min(start.y, p.y),
    width: Math.max(minimum, Math.abs(p.x - start.x)),
    height: Math.max(minimum, Math.abs(p.y - start.y)),
  };
}

export function regionLabel(region: Region) {
  if (region.type === 'page') return `Page ${region.page} · PDF points`;
  if (region.type === 'canvas') return 'Original image pixels';
  if (region.type === 'lines') return `Lines ${region.start}–${region.end}`;
  return region.type;
}

export function boundsSummary(bounds: Bounds) {
  return Object.entries(bounds)
    .filter(([k]) => ['x', 'y', 'width', 'height'].includes(k))
    .map(([k, v]) => `${k}: ${Math.round(v as number)}`)
    .join(' · ');
}

export function isAnchoredTo(annotation: Annotation, fileId: string) {
  return annotation.anchor.addresses.some((address) => address.elementId === fileId);
}

export function annotationStatus(annotation: Annotation, fileId: string) {
  if (!isAnchoredTo(annotation, fileId)) return 'Orphan';
  return annotation.resolved ? 'Resolved' : 'Open';
}

export function hasExtractableText(pages: PdfIndexedPage[]) {
  return pages.some((entry) => entry.items.some((item) => item.str.trim()));
}

export function lineSelected(region: Region | undefined, lineNumber: number) {
  return region?.type === 'lines' && lineNumber >= region.start && lineNumber <= region.end;
}

export function lineSelection(
  region: Region | undefined,
  lineNumber: number,
  extend: boolean,
): Region {
  const extending = extend && region?.type === 'lines';
  return {
    type: 'lines',
    start: extending ? Math.min(region.start, lineNumber) : lineNumber,
    end: extending ? Math.max(region.end, lineNumber) : lineNumber,
  };
}

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const SUPPORTED_MIME = /^(image\/(png|jpeg|webp|gif|svg\+xml)$|text\/|application\/pdf$)/;

export function acceptedFileMime(file: File): { mime: string } | { error: string } {
  if (file.size > MAX_FILE_BYTES) return { error: 'Use a file smaller than 32 MB' };
  const mime = file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : 'text/plain');
  if (!SUPPORTED_MIME.test(mime)) return { error: `Unsupported format: ${mime}` };
  return { mime };
}

export type OpenedFile = { content: FileContent; error?: undefined } | { error: string };

export async function readFileContent(
  file: File,
  mime: string,
  encoding: () => FileTextEncoding,
): Promise<OpenedFile> {
  try {
    const buffer = await file.arrayBuffer(),
      bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 16384)
      binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
    const originalData = `data:${mime};base64,${btoa(binary)}`;
    const data = mime.startsWith('text/')
      ? decodeFileText(bytes, file.name, encoding())
      : originalData;
    return {
      content: {
        schemaVersion: 2,
        id: newId('asset'),
        name: file.name,
        mime,
        size: file.size,
        originalData,
        data,
      },
    };
  } catch (e) {
    return { error: `File could not be opened: ${(e as Error).message}` };
  }
}
