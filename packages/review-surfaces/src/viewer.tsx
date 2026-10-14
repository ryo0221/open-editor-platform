import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Scan,
  Download,
  RotateCw,
  MousePointer2,
  Hand,
  Search,
  FolderOpen,
} from 'lucide-react';
import type { PageViewport } from 'pdfjs-dist';
import { newId } from '@editor-platform/artifact-core';
import {
  command,
  type Annotation,
  type Bounds,
  type EditorCommand,
  type ElementAddress,
  type Region,
} from '@editor-platform/editor-core';
import {
  EditorLayout,
  Dialog,
  IconButton,
  Menu,
  CommitInput,
  type EditorLayoutProps,
} from '@editor-platform/editor-ui';
import { createFile, originalBytes, type FileContent } from './model';
import { decodeFileText, type FileTextEncoding } from './text-decode';
import { PdfTextLayer, usePdfTextIndex, pdfTextSearch } from './pdf-text';
import { PdfCanvas, PdfThumbnail, usePdf } from './pdf';
import { VirtualRows } from './virtual';
import './styles.css';
export function downloadOriginal(file: FileContent) {
  const url = URL.createObjectURL(new Blob([originalBytes(file)], { type: file.mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function FileSurface({
  content,
  execute,
  select,
  readOnly = false,
  layout,
  annotations: suppliedAnnotations = [],
  focusAddress,
  viewSettings,
  onViewSettingsChange,
  onSelectionClear,
  onOpenAsNew,
  onRemapAnnotation,
}: {
  content: FileContent;
  onSelectionClear?(): void;
  onOpenAsNew?(source: FileContent): Promise<void> | void;
  onRemapAnnotation?(id: string, fileId: string, region: Region): void;

  viewSettings?: { fit?: 'page' | 'width' | 'actual'; zoom?: number; annotations?: boolean };
  onViewSettingsChange?(patch: {
    fit?: 'page' | 'width' | 'actual';
    zoom?: number;
    annotations?: boolean;
  }): void;
  execute: (cmd: EditorCommand<FileContent>) => void | boolean;
  select: (id: string, region?: Region) => void;
  readOnly?: boolean;
  layout?: Partial<EditorLayoutProps>;
  annotations?: Annotation[];
  focusAddress?: ElementAddress;
}) {
  const [replacement, setReplacement] = useState<FileContent>();
  const [replaceDialog, setReplaceDialog] = useState(false);
  const [encoding, setEncoding] = useState<FileTextEncoding>('auto');
  const currentEncoding = useRef<FileTextEncoding>('auto');
  const baseSource = useRef<{ id: string; data: string } | undefined>(undefined);
  const clearSelection = useRef(onSelectionClear);
  clearSelection.current = onSelectionClear;
  useLayoutEffect(() => {
    setRegion(undefined);
    setDrag(undefined);
    setPage(1);
    clearSelection.current?.();
  }, [content.id, content.data]);
  const annotations = viewSettings?.annotations === false ? [] : suppliedAnnotations;
  const [page, setPage] = useState(1),
    [zoom, setZoom] = useState(1),
    [rotation, setRotation] = useState(0),
    [tool, setTool] = useState<'pan' | 'region' | 'text'>('pan');
  const [error, setError] = useState(''),
    [imageSize, setImageSize] = useState({ width: 800, height: 600 });
  const [viewport, setViewport] = useState<PageViewport>(),
    [natural, setNatural] = useState({ width: 612, height: 792 });
  const [region, setRegion] = useState<Region>(),
    [drag, setDrag] = useState<Bounds>(),
    [wrap, setWrap] = useState(false),
    [query, setQuery] = useState(''),
    [targetLine, setTargetLine] = useState<number>();
  const [fitMode, setFitMode] = useState<'page' | 'width' | undefined>(
      viewSettings?.fit === 'actual' ? undefined : (viewSettings?.fit ?? 'page'),
    ),
    [viewSize, setViewSize] = useState({ width: 800, height: 600 });
  useEffect(() => {
    setFitMode(viewSettings?.fit === 'actual' ? undefined : (viewSettings?.fit ?? 'page'));
    if (viewSettings?.fit === 'actual')
      setZoom(
        Math.max(
          0.05,
          Math.min(
            4,
            typeof viewSettings.zoom === 'number' && Number.isFinite(viewSettings.zoom)
              ? viewSettings.zoom
              : 1,
          ),
        ),
      );
  }, [content.id, content.data, viewSettings?.fit, viewSettings?.zoom]);
  const scroller = useRef<HTMLDivElement>(null),
    upload = useRef<HTMLInputElement>(null),
    imageGroup = useRef<SVGGElement>(null);
  const pointer = useRef<{ x: number; y: number } | undefined>(undefined),
    pan = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined);
  const zoomAnchor = useRef<
    { x: number; y: number; left: number; top: number; old: number } | undefined
  >(undefined);
  const isPdf = content.mime === 'application/pdf',
    isImage = content.mime.startsWith('image/');
  const { pdf, error: pdfError } = usePdf(content);
  const textIndex = usePdfTextIndex(pdf);
  const pdfSearch = useMemo(() => pdfTextSearch(textIndex.pages, query), [query, textIndex.pages]);
  const pdfMatches = pdfSearch.matches;
  const [pdfMatch, setPdfMatch] = useState(0);
  const [selectedPdfMatch, setSelectedPdfMatch] = useState<{ page: number; offset: number }>();
  const lines = useMemo(
    () =>
      isPdf || isImage ? [] : content.data.split('\n').map((text, index) => ({ text, index })),
    [content.data, isPdf, isImage],
  );
  const matches = useMemo(
    () =>
      query
        ? lines
            .filter((l) => l.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
            .map((l) => l.index)
        : [],
    [lines, query],
  );
  const shownSize = isPdf
    ? natural
    : rotation % 180
      ? { width: imageSize.height, height: imageSize.width }
      : imageSize;
  useEffect(() => {
    setPage(1);
    setRegion(undefined);
    setRotation(0);
    setError('');
    setQuery('');
    setPdfMatch(0);
    setSelectedPdfMatch(undefined);
    if (!isImage) return;
    let current = true;
    const image = new Image();
    image.onload = () => {
      if (current) setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      if (current) setError('Image could not be decoded. Download the original to inspect it.');
    };
    image.src = content.data;
    return () => {
      current = false;
    };
  }, [content.id, content.data, isImage]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() =>
      setViewSize({ width: el.clientWidth, height: el.clientHeight }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [isPdf, isImage]);
  useEffect(() => {
    if (!fitMode || viewSettings?.fit === 'actual') return;
    setZoom(
      Math.max(
        0.05,
        Math.min(
          4,
          (viewSize.width - 64) / shownSize.width,
          fitMode === 'page' ? (viewSize.height - 64) / shownSize.height : 4,
        ),
      ),
    );
  }, [fitMode, viewSettings?.fit, viewSize, shownSize.width, shownSize.height]);
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current,
      el = scroller.current;
    if (!anchor || !el) return;
    const scale = zoom / anchor.old;
    el.scrollLeft = (anchor.left + anchor.x - 32) * scale + 32 - anchor.x;
    el.scrollTop = (anchor.top + anchor.y - 32) * scale + 32 - anchor.y;
    zoomAnchor.current = undefined;
  }, [zoom]);
  function changeZoom(next: number, x = viewSize.width / 2, y = viewSize.height / 2) {
    const el = scroller.current;
    if (el) zoomAnchor.current = { x, y, left: el.scrollLeft, top: el.scrollTop, old: zoom };
    setFitMode(undefined);
    const bounded = Math.max(0.05, Math.min(4, next));
    setZoom(bounded);
    onViewSettingsChange?.({ fit: 'actual', zoom: bounded });
  }
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        changeZoom(zoom * Math.exp(-e.deltaY * 0.005), e.clientX - r.left, e.clientY - r.top);
      }
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [zoom, viewSize, isPdf, isImage]);
  useEffect(() => {
    if (focusAddress?.elementId !== content.id) return;
    const r = focusAddress.region;
    setRegion(r);
    if (r?.type === 'page') setPage(Math.max(1, Math.min(pdf?.numPages ?? r.page, r.page)));
    if (r?.type === 'lines') setTargetLine(r.start - 1);
  }, [focusAddress, content.id, pdf?.numPages]);
  function choose(r: Region) {
    setRegion(r);
    select(content.id, r);
  }
  function point(e: PointerEvent<SVGSVGElement>) {
    if (isPdf && viewport) {
      const box = e.currentTarget.getBoundingClientRect(),
        [x, y] = viewport.convertToPdfPoint(
          ((e.clientX - box.left) * viewport.width) / box.width,
          ((e.clientY - box.top) * viewport.height) / box.height,
        );
      return { x, y };
    }
    const matrix = imageGroup.current?.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
    return {
      x: Math.max(0, Math.min(imageSize.width, p.x)),
      y: Math.max(0, Math.min(imageSize.height, p.y)),
    };
  }
  const regionEvents = {
    onPointerDown: (e: PointerEvent<SVGSVGElement>) => {
      if (tool !== 'region') return;
      e.preventDefault();
      e.stopPropagation();
      pointer.current = point(e);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: PointerEvent<SVGSVGElement>) => {
      if (!pointer.current) return;
      const p = point(e),
        start = pointer.current;
      setDrag({
        x: Math.min(start.x, p.x),
        y: Math.min(start.y, p.y),
        width: Math.abs(p.x - start.x),
        height: Math.abs(p.y - start.y),
      });
    },
    onPointerUp: (e: PointerEvent<SVGSVGElement>) => {
      if (!pointer.current) return;
      const p = point(e),
        start = pointer.current;
      pointer.current = undefined;
      setDrag(undefined);
      if (e.currentTarget.hasPointerCapture(e.pointerId))
        e.currentTarget.releasePointerCapture(e.pointerId);
      const bounds = {
        x: Math.min(start.x, p.x),
        y: Math.min(start.y, p.y),
        width: Math.max(1, Math.abs(p.x - start.x)),
        height: Math.max(1, Math.abs(p.y - start.y)),
      };
      choose(
        isPdf
          ? { type: 'page', page, units: 'pdf-points', bounds }
          : { type: 'canvas', units: 'image-pixels', ...bounds },
      );
    },
    onPointerCancel: () => {
      pointer.current = undefined;
      setDrag(undefined);
    },
  };
  function rectangle(r: Region | undefined): Bounds | undefined {
    if (!r) return;
    if (isImage && r.type === 'canvas')
      return r.units === 'image-pixels'
        ? r
        : {
            x: r.x * imageSize.width,
            y: r.y * imageSize.height,
            width: r.width * imageSize.width,
            height: r.height * imageSize.height,
          };
    if (isPdf && r.type === 'page' && r.page === page && r.bounds) return r.bounds;
  }
  function renderedRect(b: Bounds): Bounds {
    if (!isPdf || !viewport) return b;
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([
      b.x,
      b.y,
      b.x + b.width,
      b.y + b.height,
    ]);
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x1 - x2),
      height: Math.abs(y1 - y2),
    };
  }
  const regions = annotations.flatMap((a) =>
    a.anchor.addresses
      .filter((x) => x.elementId === content.id)
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
  const active = drag ?? rectangle(region);
  const overlays = (
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
  async function openFile(file: File) {
    if (readOnly) return;
    if (file.size > 32 * 1024 * 1024) {
      setError('Use a file smaller than 32 MB');
      return;
    }
    const mime = file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : 'text/plain');
    if (!/^(image\/(png|jpeg|webp|gif|svg\+xml)$|text\/|application\/pdf$)/.test(mime)) {
      setError(`Unsupported format: ${mime}`);
      return;
    }
    try {
      const buffer = await file.arrayBuffer(),
        bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 16384)
        binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
      const originalData = `data:${mime};base64,${btoa(binary)}`;
      const data = mime.startsWith('text/')
        ? decodeFileText(bytes, file.name, currentEncoding.current)
        : originalData;
      const next: FileContent = {
        schemaVersion: 2,
        id: newId('asset'),
        name: file.name,
        mime,
        size: file.size,
        originalData,
        data,
      };
      setReplacement(next);
      setError('');
    } catch (e) {
      setError(`File could not be opened: ${(e as Error).message}`);
    }
  }
  const imageTransform =
    rotation === 90
      ? `translate(${imageSize.height} 0) rotate(90)`
      : rotation === 180
        ? `translate(${imageSize.width} ${imageSize.height}) rotate(180)`
        : rotation === 270
          ? `translate(0 ${imageSize.width}) rotate(270)`
          : undefined;
  return (
    <EditorLayout
      viewKey="file"
      leftLabel="File navigator"
      inspectorLabel="File inspector"
      left={
        isPdf ? (
          <nav aria-label="PDF pages">
            {pdf ? (
              Array.from({ length: pdf.numPages }, (_, i) => (
                <PdfThumbnail
                  key={i}
                  pdf={pdf}
                  page={i + 1}
                  selected={i + 1 === page}
                  onClick={() => {
                    setPage(i + 1);
                    setRegion(undefined);
                  }}
                />
              ))
            ) : (
              <p>Loading PDF pages…</p>
            )}
          </nav>
        ) : (
          <div className="ep-file-nav">
            <strong>{content.name}</strong>
            <p>
              {isImage
                ? 'Image coordinates use original pixels.'
                : `${lines.length.toLocaleString()} lines`}
            </p>
            {matches.slice(0, 100).map((i) => (
              <button key={i} onClick={() => setTargetLine(i)}>
                Line {i + 1} · {lines[i].text.slice(0, 32)}
              </button>
            ))}
          </div>
        )
      }
      inspector={
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
          {region ? (
            <p>
              {region.type === 'page'
                ? `Page ${region.page} · PDF points`
                : region.type === 'canvas'
                  ? 'Original image pixels'
                  : region.type === 'lines'
                    ? `Lines ${region.start}–${region.end}`
                    : region.type}
            </p>
          ) : (
            <p>Select a range or region to anchor a comment.</p>
          )}
          {active && (
            <p>
              {Object.entries(active)
                .filter(([k]) => ['x', 'y', 'width', 'height'].includes(k))
                .map(([k, v]) => `${k}: ${Math.round(v as number)}`)
                .join(' · ')}
            </p>
          )}
          <h3>Annotations</h3>
          {annotations.map((a) => (
            <div key={a.id}>
              <button
                style={a.color ? { borderInlineStart: `3px solid ${a.color}` } : undefined}
                onClick={() => {
                  const address = a.anchor.addresses.find((x) => x.elementId === content.id);
                  if (!address) return;
                  const r = address.region;
                  if (r?.type === 'page') setPage(r.page);
                  if (r?.type === 'lines') setTargetLine(r.start - 1);
                  if (r) choose(r);
                }}
              >
                {a.comments[0]?.body} ·{' '}
                {a.anchor.addresses.some((x) => x.elementId === content.id)
                  ? a.resolved
                    ? 'Resolved'
                    : 'Open'
                  : 'Orphan'}
              </button>
              {!a.anchor.addresses.some((address) => address.elementId === content.id) && (
                <button
                  disabled={readOnly || !region || !onRemapAnnotation}
                  onClick={() => {
                    if (region) onRemapAnnotation?.(a.id, content.id, region);
                  }}
                >
                  Remap annotation to current selection
                </button>
              )}
            </div>
          ))}
        </div>
      }
      toolbar={
        <>
          <IconButton
            icon={FolderOpen}
            label="Replace source"
            disabled={readOnly}
            onClick={() => {
              baseSource.current = { id: content.id, data: content.data };
              setReplacement(undefined);
              setError('');
              setReplaceDialog(true);
            }}
          />
          <input
            ref={upload}
            hidden
            type="file"
            aria-label="Open file"
            accept="image/*,text/*,.log,.md,.pdf"
            disabled={readOnly}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void openFile(file);
              e.target.value = '';
            }}
          />
          {isPdf && (
            <>
              <input
                aria-label="Search PDF text"
                placeholder="PDF内の文字を検索"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPdfMatch(0);
                  setSelectedPdfMatch(undefined);
                }}
              />
              <button
                disabled={!pdfMatches.length}
                onClick={() => {
                  const next = pdfMatches[pdfMatch % pdfMatches.length];
                  setPage(next.page);
                  setTool('text');
                  setSelectedPdfMatch(next);
                  setPdfMatch((pdfMatch + 1) % pdfMatches.length);
                }}
              >
                Next PDF text match
              </button>
              <span role="status">
                {pdfMatches.length} text matches{pdfSearch.truncated ? ' (partial)' : ''}
              </span>
              <IconButton
                icon={ChevronLeft}
                label="Previous PDF page"
                disabled={!pdf || page <= 1}
                onClick={() => setPage(page - 1)}
              />
              <CommitInput
                label="PDF page"
                type="number"
                min={1}
                max={pdf?.numPages ?? 1}
                value={page}
                onCommit={(v) => {
                  setPage(Math.max(1, Math.min(pdf?.numPages ?? 1, Number(v) || 1)));
                  setRegion(undefined);
                }}
              />
              <span className="ep-muted">/ {pdf?.numPages ?? '…'}</span>
              <IconButton
                icon={ChevronRight}
                label="Next PDF page"
                disabled={!pdf || page >= pdf.numPages}
                onClick={() => setPage(page + 1)}
              />
            </>
          )}
          {isPdf || isImage ? (
            <>
              <IconButton icon={ZoomOut} label="Zoom out" onClick={() => changeZoom(zoom / 1.2)} />
              <select
                aria-label="File zoom"
                value={String(zoom)}
                onChange={(e) => changeZoom(Number(e.target.value))}
              >
                <option value={String(zoom)}>{Math.round(zoom * 100)}%</option>
                {[0.25, 0.5, 1, 1.5, 2, 3, 4]
                  .filter((v) => v !== zoom)
                  .map((v) => (
                    <option key={v} value={v}>
                      {v * 100}%
                    </option>
                  ))}
              </select>
              <IconButton icon={ZoomIn} label="Zoom in" onClick={() => changeZoom(zoom * 1.2)} />
              <IconButton
                icon={Scan}
                label={isPdf ? 'Fit PDF page' : 'Fit image'}
                onClick={() => {
                  setFitMode('page');
                  onViewSettingsChange?.({ fit: 'page' });
                }}
              />
              {isPdf && (
                <button
                  onClick={() => {
                    setFitMode('width');
                    onViewSettingsChange?.({ fit: 'width' });
                  }}
                >
                  Fit width
                </button>
              )}
              <IconButton
                icon={RotateCw}
                label="Rotate view clockwise"
                onClick={() => setRotation((rotation + 90) % 360)}
              />
              <IconButton
                icon={Hand}
                label="Pan file"
                aria-pressed={tool === 'pan'}
                onClick={() => setTool('pan')}
              />
              <IconButton
                icon={MousePointer2}
                label="Select file region"
                aria-pressed={tool === 'region'}
                onClick={() => setTool('region')}
              />
              {isPdf && (
                <>
                  <button onClick={() => choose({ type: 'page', page })}>Select page</button>
                  <button aria-pressed={tool === 'text'} onClick={() => setTool('text')}>
                    Select PDF text
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <input
                aria-label="Search file"
                placeholder="Search text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <IconButton
                icon={Search}
                label="Next file match"
                disabled={!matches.length}
                onClick={() =>
                  setTargetLine(matches.find((n) => n > (targetLine ?? -1)) ?? matches[0])
                }
              />
              <label className="ep-toolbar-check">
                <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />{' '}
                Wrap lines
              </label>
            </>
          )}
          <span className="ep-spacer" />
          <IconButton
            icon={Download}
            label="Download original file"
            onClick={() => downloadOriginal(content)}
          />
          <Menu label="Sample files">
            {(['text', 'image', 'pdf'] as const).map((kind) => (
              <button
                key={kind}
                disabled={readOnly}
                onClick={() => {
                  const demo = createFile(kind);
                  execute(command('file.sample', `Open sample ${kind}`, () => demo));
                }}
              >
                Demo {kind.toUpperCase()}
              </button>
            ))}
          </Menu>
        </>
      }
      {...layout}
    >
      <div className="ep-file-body">
        {isPdf && pdfSearch.truncated && (
          <p role="status" className="ep-muted">
            検索結果の一部を表示しています。各ページの先頭10,000件まで移動できます。検索語を絞り込んでください。
          </p>
        )}
        {isPdf &&
          textIndex.done &&
          !textIndex.error &&
          !textIndex.pages.some((entry) => entry.items.some((item) => item.str.trim())) && (
            <p role="status">
              このPDFには抽出できる文字がありません。領域選択は利用できます。OCRはHost拡張で、ここでは提供していません。
            </p>
          )}
        {isPdf && textIndex.error && (
          <p role="alert">文字の抽出に失敗しました: {textIndex.error}</p>
        )}
        {replaceDialog && (
          <Dialog
            title="Replace source"
            onClose={() => {
              setReplaceDialog(false);
              setReplacement(undefined);
            }}
          >
            <p>
              現在の原本: {content.name} · {content.mime} · {content.size} bytes
            </p>
            <p>
              {
                suppliedAnnotations.filter((annotation) =>
                  annotation.anchor.addresses.some((address) => address.elementId === content.id),
                ).length
              }{' '}
              annotations may become Orphan.
              新しい原本へ自動では紐付けません。置換はUndoで戻せます。
            </p>
            <label>
              Text encoding
              <select
                aria-label="File text encoding"
                value={encoding}
                onChange={(event) => {
                  const nextEncoding = event.target.value as FileTextEncoding;
                  currentEncoding.current = nextEncoding;
                  setEncoding(nextEncoding);
                  if (!replacement?.mime.startsWith('text/')) return;
                  try {
                    setReplacement({
                      ...replacement,
                      data: decodeFileText(
                        originalBytes(replacement),
                        replacement.name,
                        nextEncoding,
                      ),
                    });
                    setError('');
                  } catch (error) {
                    setReplacement(undefined);
                    setError(`文字コードを確認して原本を選び直してください: ${String(error)}`);
                  }
                }}
              >
                {(['auto', 'utf-8', 'utf-16le', 'utf-16be', 'shift_jis'] as const).map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <button onClick={() => upload.current?.click()}>Choose replacement file</button>
            {replacement && (
              <p>
                新しい原本: {replacement.name} · {replacement.mime}
              </p>
            )}
            {error && <p role="alert">{error}</p>}
            <button
              disabled={readOnly || !replacement}
              onClick={() => {
                if (!replacement) return;
                const next = replacement;
                try {
                  if (
                    execute(
                      command('file.replace', 'Replace source', (current) => {
                        if (
                          current.id !== baseSource.current?.id ||
                          current.data !== baseSource.current?.data
                        )
                          throw new Error('原本が変更されました。置換を開き直してください。');
                        return next;
                      }),
                    ) !== false
                  ) {
                    setReplaceDialog(false);
                    setReplacement(undefined);
                  }
                } catch (error) {
                  setError(String(error));
                }
              }}
            >
              Confirm source replacement
            </button>
            <button
              disabled={readOnly || !replacement || !onOpenAsNew}
              title={!onOpenAsNew ? 'Hostは新しい成果物の作成を提供していません。' : undefined}
              onClick={async () => {
                if (replacement) {
                  try {
                    await onOpenAsNew?.(replacement);
                    setReplaceDialog(false);
                  } catch (error) {
                    setError(String(error));
                  }
                }
              }}
            >
              Open as new artifact
            </button>
            <button
              onClick={() => {
                setReplaceDialog(false);
                setReplacement(undefined);
              }}
            >
              Cancel replacement
            </button>
          </Dialog>
        )}
        {(error || pdfError) && (
          <p role="alert" className="ep-file-error">
            {error || pdfError}{' '}
            <button onClick={() => downloadOriginal(content)}>Download original</button>
          </p>
        )}
        {isPdf || isImage ? (
          <div
            ref={scroller}
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
            {isPdf ? (
              pdf ? (
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
                    onViewport={(v, n) => {
                      setViewport(v);
                      setNatural(n);
                    }}
                    onError={setError}
                  />
                  {viewport && tool === 'text' && (
                    <PdfTextLayer
                      pdf={pdf}
                      page={page}
                      viewport={viewport}
                      query={query}
                      selectedOffset={
                        selectedPdfMatch?.page === page ? selectedPdfMatch.offset : undefined
                      }
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
              ) : (
                !pdfError && <p>Rendering PDF…</p>
              )
            ) : (
              <svg
                aria-label="Select image region"
                className="ep-image-page"
                width={shownSize.width * zoom}
                height={shownSize.height * zoom}
                viewBox={`0 0 ${shownSize.width} ${shownSize.height}`}
                {...regionEvents}
              >
                <g ref={imageGroup} transform={imageTransform}>
                  <image href={content.data} width={imageSize.width} height={imageSize.height} />
                  <g>{overlays}</g>
                </g>
              </svg>
            )}
          </div>
        ) : (
          <div className={`ep-text-view ${wrap ? 'wrap' : ''}`}>
            <VirtualRows
              rows={lines}
              rowKey={(l) => String(l.index)}
              focusIndex={targetLine}
              label="Text file"
              render={(line) => (
                <button
                  className={`ep-file-line ${region?.type === 'lines' && line.index + 1 >= region.start && line.index + 1 <= region.end ? 'selected' : ''}`}
                  aria-label={`File line ${line.index + 1}`}
                  onClick={(e) =>
                    choose({
                      type: 'lines',
                      start:
                        e.shiftKey && region?.type === 'lines'
                          ? Math.min(region.start, line.index + 1)
                          : line.index + 1,
                      end:
                        e.shiftKey && region?.type === 'lines'
                          ? Math.max(region.end, line.index + 1)
                          : line.index + 1,
                    })
                  }
                >
                  <span className="ep-line-number">{line.index + 1}</span>
                  <code>{line.text || ' '}</code>
                </button>
              )}
            />
          </div>
        )}
      </div>
    </EditorLayout>
  );
}
