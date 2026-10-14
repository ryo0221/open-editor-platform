import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, PageViewport } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { originalBytes, type FileContent } from './model';
export function usePdf(content: FileContent) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>(),
    [error, setError] = useState('');
  useEffect(() => {
    setPdf(undefined);
    setError('');
    if (content.mime !== 'application/pdf') return;
    let cancelled = false,
      destroy: (() => Promise<void>) | undefined;
    void import('pdfjs-dist')
      .then(async (engine) => {
        if (cancelled) return;
        engine.GlobalWorkerOptions.workerSrc = workerUrl;
        const task = engine.getDocument({
          data: originalBytes(content),
          isEvalSupported: false,
          useSystemFonts: true,
        });
        destroy = () => task.destroy();
        const doc = await task.promise;
        if (!cancelled) setPdf(doc);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(`PDF could not be opened: ${e.message}`);
      });
    return () => {
      cancelled = true;
      void destroy?.().catch(() => undefined);
    };
  }, [content.id, content.data, content.originalData, content.mime]);
  return { pdf, error };
}
export function PdfCanvas({
  pdf,
  page,
  zoom,
  rotation = 0,
  onViewport,
  onError,
  thumbnail = false,
}: {
  pdf: PDFDocumentProxy;
  page: number;
  zoom: number;
  rotation?: number;
  thumbnail?: boolean;
  onViewport?: (viewport: PageViewport, natural: { width: number; height: number }) => void;
  onError?: (message: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    callback = useRef(onViewport),
    errorCallback = useRef(onError);
  callback.current = onViewport;
  errorCallback.current = onError;
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false,
      cancelRender: (() => void) | undefined;
    setReady(false);
    void pdf
      .getPage(page)
      .then(async (source) => {
        if (cancelled || !canvas.current) return;
        const natural = source.getViewport({ scale: 1, rotation: source.rotate + rotation });
        const scale = thumbnail ? 145 / natural.width : zoom;
        const viewport = source.getViewport({ scale, rotation: source.rotate + rotation });
        const ratio = thumbnail ? 1 : Math.min(2, window.devicePixelRatio || 1);
        const output = canvas.current;
        output.width = Math.ceil(viewport.width * ratio);
        output.height = Math.ceil(viewport.height * ratio);
        output.style.width = `${viewport.width}px`;
        output.style.height = `${viewport.height}px`;
        callback.current?.(viewport, { width: natural.width, height: natural.height });
        const task = source.render({
          canvas: output,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        });
        cancelRender = () => task.cancel();
        await task.promise;
        if (!cancelled) setReady(true);
      })
      .catch((e: Error) => {
        if (!cancelled && e.name !== 'RenderingCancelledException')
          errorCallback.current?.(e.message);
      });
    return () => {
      cancelled = true;
      cancelRender?.();
    };
  }, [pdf, page, zoom, rotation, thumbnail]);
  return (
    <canvas
      ref={canvas}
      aria-label={`${thumbnail ? 'PDF thumbnail' : 'Rendered PDF page'} ${page}`}
      data-rendered={ready}
    />
  );
}
export function PdfThumbnail({
  pdf,
  page,
  selected,
  onClick,
}: {
  pdf: PDFDocumentProxy;
  page: number;
  selected: boolean;
  onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null),
    [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: '100px',
    });
    observer.observe(ref.current!);
    return () => observer.disconnect();
  }, []);
  return (
    <button
      ref={ref}
      className="ep-pdf-thumbnail"
      aria-label={`Go to PDF page ${page}`}
      aria-pressed={selected}
      onClick={onClick}
    >
      {visible && <PdfCanvas pdf={pdf} page={page} zoom={1} thumbnail />}
      <span>Page {page}</span>
    </button>
  );
}
