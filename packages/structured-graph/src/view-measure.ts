import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import { type GraphLabelSizes, type GraphNodeHeights } from './view-model';

function measureNodeHeight(content: HTMLElement, node: HTMLElement) {
  const button = content.parentElement!;
  const buttonStyle = getComputedStyle(button),
    nodeStyle = getComputedStyle(node);
  // The label's own height; the scene raises it to the 70px minimum and the shape's needs.
  return Math.max(
    0,
    Math.ceil(
      content.offsetHeight +
        parseFloat(buttonStyle.paddingTop) +
        parseFloat(buttonStyle.paddingBottom) +
        parseFloat(buttonStyle.borderTopWidth) +
        parseFloat(buttonStyle.borderBottomWidth) +
        parseFloat(nodeStyle.borderTopWidth) +
        parseFloat(nodeStyle.borderBottomWidth),
    ),
  );
}

function sameNodeHeights(previous: GraphNodeHeights, measured: GraphNodeHeights) {
  return (
    previous.size === measured.size &&
    [...measured].every(([id, next]) => {
      const old = previous.get(id);
      return old?.key === next.key && old.height === next.height;
    })
  );
}

function useNodeHeights(canvas: RefObject<HTMLDivElement | null>) {
  const [nodeHeights, setNodeHeights] = useState<GraphNodeHeights>(new Map());
  useLayoutEffect(() => {
    const contents = canvas.current?.querySelectorAll<HTMLElement>('.ep-graph-node-content') ?? [];
    const measure = () => {
      const measured: GraphNodeHeights = new Map();
      for (const content of contents) {
        const node = content.closest<HTMLElement>('[data-auto-size-key]');
        if (!node || !content.offsetWidth) continue;
        const height = measureNodeHeight(content, node);
        measured.set(node.dataset.nodeId!, { key: node.dataset.autoSizeKey!, height });
      }
      setNodeHeights((previous) => (sameNodeHeights(previous, measured) ? previous : measured));
    };
    measure();
    // Natural content size changes on font load and on Host typography changes.
    const observer = new ResizeObserver(measure);
    for (const content of contents) observer.observe(content);
    return () => observer.disconnect();
  });
  return nodeHeights;
}

function useFontRefresh() {
  const [, refreshFonts] = useState(0);
  useEffect(() => {
    let active = true;
    const changed = () => {
      if (active) refreshFonts((n) => n + 1);
    };
    void document.fonts.ready.then(changed);
    document.fonts.addEventListener('loadingdone', changed);
    return () => {
      active = false;
      document.fonts.removeEventListener('loadingdone', changed);
    };
  }, []);
}

function measureEdgeLabel(text: SVGTextElement) {
  const box = text.getBBox();
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) return;
  const x = Number(text.getAttribute('x')),
    y = Number(text.getAttribute('y')) - 4;
  return {
    text: text.textContent ?? '',
    // A mounted whitespace/zero-glyph label is measured even with zero ink.
    // Its zero box may be at the SVG origin rather than at the text anchor.
    width:
      box.width === 0
        ? 50
        : Math.max(
            50,
            Math.ceil(2 * Math.max(Math.abs(box.x - x), Math.abs(box.x + box.width - x)) + 16),
          ),
    height:
      box.height === 0
        ? 22
        : Math.max(
            22,
            Math.ceil(2 * Math.max(Math.abs(box.y - y), Math.abs(box.y + box.height - y)) + 8),
          ),
  };
}

function sameLabelSizes(previous: GraphLabelSizes, measured: GraphLabelSizes) {
  return (
    previous.size === measured.size &&
    [...measured].every(([id, next]) => {
      const old = previous.get(id);
      return old?.text === next.text && old.width === next.width && old.height === next.height;
    })
  );
}

function useEdgeLabelSizes(canvas: RefObject<HTMLDivElement | null>) {
  const [labelSizes, setLabelSizes] = useState<GraphLabelSizes>(new Map());
  useLayoutEffect(() => {
    const measured: GraphLabelSizes = new Map();
    for (const text of canvas.current?.querySelectorAll<SVGTextElement>(
      '.ep-graph-edge-label text',
    ) ?? []) {
      const id = text.closest('[data-edge-id]')?.getAttribute('data-edge-id');
      if (!id) continue;
      const size = measureEdgeLabel(text);
      if (size) measured.set(id, size);
    }
    setLabelSizes((previous) => (sameLabelSizes(previous, measured) ? previous : measured));
  });
  return labelSizes;
}

function useViewportSize(canvas: RefObject<HTMLDivElement | null>) {
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const measure = () => setViewport({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return viewport;
}

/** DOM measurements of the mounted canvas, refreshed after fonts load and on resize. */
export function useGraphMeasurements(canvas: RefObject<HTMLDivElement | null>) {
  const nodeHeights = useNodeHeights(canvas);
  useFontRefresh();
  const labelSizes = useEdgeLabelSizes(canvas);
  const viewport = useViewportSize(canvas);
  return { nodeHeights, labelSizes, viewport };
}
