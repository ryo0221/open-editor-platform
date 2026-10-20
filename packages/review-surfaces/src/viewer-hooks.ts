import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from 'react';
import type { PageViewport } from 'pdfjs-dist';
import type { Bounds, ElementAddress, Region } from '@editor-platform/editor-core';
import type { FileContent } from './model';
import { pdfTextSearch, type PdfIndexedPage } from './pdf-text';
import type { RegionPointerEvents } from './viewer-stage';
import {
  clampZoom,
  dragBounds,
  fitZoom,
  initialFitMode,
  settingsZoom,
  type FileTool,
  type FileViewSettings,
  type Size,
} from './viewer-utils';

export function useSelectionReset(content: FileContent, reset: () => void) {
  useLayoutEffect(() => {
    reset();
  }, [content.id, content.data]);
}

export function useSettingsZoom(content: FileContent, viewSettings?: FileViewSettings) {
  const [zoom, setZoom] = useState(1);
  const [fitMode, setFitMode] = useState<'page' | 'width' | undefined>(
    initialFitMode(viewSettings),
  );
  useEffect(() => {
    setFitMode(initialFitMode(viewSettings));
    if (viewSettings?.fit === 'actual') setZoom(settingsZoom(viewSettings.zoom));
  }, [content.id, content.data, viewSettings?.fit, viewSettings?.zoom]);
  return { zoom, setZoom, fitMode, setFitMode };
}

export function useContentReset(
  content: FileContent,
  isImage: boolean,
  reset: () => void,
  image: { onSize(size: Size): void; onError(error: string): void },
) {
  useEffect(() => {
    reset();
    if (!isImage) return;
    let current = true;
    const element = new Image();
    element.onload = () => {
      if (current) image.onSize({ width: element.naturalWidth, height: element.naturalHeight });
    };
    element.onerror = () => {
      if (current)
        image.onError('Image could not be decoded. Download the original to inspect it.');
    };
    element.src = content.data;
    return () => {
      current = false;
    };
  }, [content.id, content.data, isImage]);
}

export function useZoomViewport({
  scroller,
  zoom,
  setZoom,
  fitMode,
  setFitMode,
  settingsFit,
  shownSize,
  isPdf,
  isImage,
  onViewSettingsChange,
}: {
  scroller: RefObject<HTMLDivElement | null>;
  zoom: number;
  setZoom(zoom: number): void;
  fitMode: 'page' | 'width' | undefined;
  setFitMode(mode: 'page' | 'width' | undefined): void;
  settingsFit: FileViewSettings['fit'];
  shownSize: Size;
  isPdf: boolean;
  isImage: boolean;
  onViewSettingsChange?(patch: FileViewSettings): void;
}) {
  const [viewSize, setViewSize] = useState({ width: 800, height: 600 });
  const zoomAnchor = useRef<
    { x: number; y: number; left: number; top: number; old: number } | undefined
  >(undefined);
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
    if (!fitMode || settingsFit === 'actual') return;
    setZoom(fitZoom(fitMode, viewSize, shownSize));
  }, [fitMode, settingsFit, viewSize, shownSize.width, shownSize.height]);
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
    const bounded = clampZoom(next);
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
  return changeZoom;
}

export function useFocusAddress(
  focusAddress: ElementAddress | undefined,
  fileId: string,
  numPages: number | undefined,
  focus: {
    setRegion(r: Region | undefined): void;
    setPage(page: number): void;
    setTargetLine(line: number): void;
  },
) {
  useEffect(() => {
    if (focusAddress?.elementId !== fileId) return;
    const { setRegion, setPage, setTargetLine } = focus;
    const r = focusAddress.region;
    setRegion(r);
    if (r?.type === 'page') setPage(Math.max(1, Math.min(numPages ?? r.page, r.page)));
    if (r?.type === 'lines') setTargetLine(r.start - 1);
  }, [focusAddress, fileId, numPages]);
}

export function useRegionDrag({
  tool,
  isPdf,
  viewport,
  imageGroup,
  imageSize,
  page,
  setDrag,
  choose,
}: {
  tool: FileTool;
  isPdf: boolean;
  viewport: PageViewport | undefined;
  imageGroup: RefObject<SVGGElement | null>;
  imageSize: Size;
  page: number;
  setDrag(bounds: Bounds | undefined): void;
  choose(region: Region): void;
}): RegionPointerEvents {
  const pointer = useRef<{ x: number; y: number } | undefined>(undefined);
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
  return {
    onPointerDown: (e) => {
      if (tool !== 'region') return;
      e.preventDefault();
      e.stopPropagation();
      pointer.current = point(e);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e) => {
      if (!pointer.current) return;
      setDrag(dragBounds(pointer.current, point(e)));
    },
    onPointerUp: (e) => {
      if (!pointer.current) return;
      const p = point(e),
        start = pointer.current;
      pointer.current = undefined;
      setDrag(undefined);
      if (e.currentTarget.hasPointerCapture(e.pointerId))
        e.currentTarget.releasePointerCapture(e.pointerId);
      const bounds = dragBounds(start, p, 1);
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
}

export function usePdfSearch(pages: PdfIndexedPage[]) {
  const [query, setQuery] = useState('');
  const pdfSearch = useMemo(() => pdfTextSearch(pages, query), [query, pages]);
  const [pdfMatch, setPdfMatch] = useState(0);
  const [selectedMatch, setSelectedMatch] = useState<{ page: number; offset: number }>();
  function reset() {
    setQuery('');
    setPdfMatch(0);
    setSelectedMatch(undefined);
  }
  function changeQuery(next: string) {
    setQuery(next);
    setPdfMatch(0);
    setSelectedMatch(undefined);
  }
  function advance() {
    const matches = pdfSearch.matches;
    const next = matches[pdfMatch % matches.length];
    setSelectedMatch(next);
    setPdfMatch((pdfMatch + 1) % matches.length);
    return next;
  }
  return { query, setQuery, pdfSearch, selectedMatch, reset, changeQuery, advance };
}
