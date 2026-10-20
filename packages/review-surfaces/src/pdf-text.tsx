import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
type TextItem = Extract<
  Awaited<ReturnType<PDFPageProxy['getTextContent']>>['items'][number],
  { str: string }
>;
export interface PdfIndexedPage {
  page: number;
  text: string;
  items: TextItem[];
}
export function pdfTextSearch(pages: PdfIndexedPage[], query: string) {
  let truncated = false;
  if (!query) return { matches: [], truncated };
  const matches = pages.flatMap((page) => {
    const source = page.text.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    const result: { page: number; offset: number; text: string }[] = [];
    for (
      let offset = source.indexOf(needle);
      offset !== -1;
      offset = source.indexOf(needle, offset + needle.length)
    ) {
      if (result.length === 10000) {
        truncated = true;
        break;
      }
      result.push({ page: page.page, offset, text: query });
    }
    return result;
  });
  return { matches, truncated };
}
export function pdfTextMatches(pages: PdfIndexedPage[], query: string) {
  return pdfTextSearch(pages, query).matches;
}
/** Viewer-only index, discarded on source change. Extraction never rewrites original bytes. */
export function usePdfTextIndex(pdf?: PDFDocumentProxy) {
  const [index, setIndex] = useState<{ pages: PdfIndexedPage[]; done: boolean; error: string }>({
    pages: [],
    done: false,
    error: '',
  });
  useEffect(() => {
    let cancelled = false;
    setIndex({ pages: [], done: false, error: '' });
    if (!pdf) return;
    void (async () => {
      if (pdf.numPages > 500)
        throw new Error('文字検索は500ページまでです。原本の閲覧・領域注釈は利用できます。');
      const pages: PdfIndexedPage[] = [];
      let total = 0;
      for (let page = 1; page <= pdf.numPages; page++) {
        const content = await (await pdf.getPage(page)).getTextContent();
        if (cancelled) return;
        const items = content.items.filter((item): item is TextItem => 'str' in item);
        const text = items.map((item) => item.str + (item.hasEOL ? '\n' : '')).join('');
        total += text.length;
        if (total > 2_000_000)
          throw new Error('文字検索の200万文字上限を超えました。原本の閲覧は利用できます。');
        pages.push({ page, text, items });
      }
      if (!cancelled) setIndex({ pages, done: true, error: '' });
    })().catch((error) => {
      if (!cancelled)
        setIndex({
          pages: [],
          done: true,
          error: String(error instanceof Error ? error.message : error),
        });
    });
    return () => {
      cancelled = true;
    };
  }, [pdf]);
  return index;
}
export function PdfTextLayer({
  pdf,
  page,
  viewport,
  query,
  selectedOffset,
}: {
  pdf: PDFDocumentProxy;
  page: number;
  viewport: PageViewport;
  query: string;
  selectedOffset?: number;
}) {
  const mount = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    let cancel: (() => void) | undefined;
    const container = mount.current!;
    container.replaceChildren();
    container.style.setProperty('--total-scale-factor', String(viewport.scale));
    void (async () => {
      const engine = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const source = await pdf.getPage(page);
      const text = await source.getTextContent();
      if (cancelled) return;
      const layer = new engine.TextLayer({ textContentSource: text, container, viewport });
      cancel = () => layer.cancel();
      await layer.render();
      if (!cancelled && query) {
        const items = text.items.filter((item): item is TextItem => 'str' in item);
        const matches = pdfTextMatches(
          [
            {
              page,
              text: items.map((item) => item.str + (item.hasEOL ? '\n' : '')).join(''),
              items,
            },
          ],
          query,
        );
        let start = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i],
            span = layer.textDivs[i];
          const end = start + item.str.length;
          if (
            span &&
            matches.some((match) => match.offset < end && match.offset + query.length > start)
          ) {
            span.classList.add('ep-pdf-text-match');
            span.dataset.pdfMatch = 'true';
            if (
              selectedOffset !== undefined &&
              selectedOffset < end &&
              selectedOffset + query.length > start
            )
              span.dataset.pdfActiveMatch = 'true';
          }
          start = end + (item.hasEOL ? 1 : 0);
        }
        (
          container.querySelector('[data-pdf-active-match]') ??
          container.querySelector('[data-pdf-match]')
        )?.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
    })().catch(() => {
      if (!cancelled) container.textContent = 'PDF text selection could not be loaded';
    });
    return () => {
      cancelled = true;
      cancel?.();
      container.replaceChildren();
    };
  }, [pdf, page, viewport, query, selectedOffset]);
  return (
    <div
      ref={mount}
      className="ep-pdf-text-layer"
      aria-label={`PDF selectable text page ${page}`}
      onPointerDown={(event) => event.stopPropagation()}
    />
  );
}
