import { useEffect, useRef, type RefObject } from 'react';
import type { Bounds } from '@editor-platform/editor-core';
import type { CanvasView } from './index';
import { fitCanvasView, wheelCanvasView } from './stage-model';

type ViewSetter = RefObject<(view: CanvasView) => void>;

/** Keeps a fitted view fitted across element resizes and fit-bounds changes. */
export function useCanvasFit(options: {
  svg: RefObject<SVGSVGElement | null>;
  viewRef: RefObject<CanvasView>;
  setter: ViewSetter;
  space: 'page' | 'infinite';
  fit: boolean;
  width: number;
  height: number;
  bounds: Bounds;
  onSize(size: { width: number; height: number }): void;
}) {
  const { svg, viewRef, setter, space, width, height, bounds, onSize } = options;
  const fit = () => {
    const current = viewRef.current,
      box = svg.current?.getBoundingClientRect();
    if (!box) return;
    setter.current(fitCanvasView(current, box, bounds, space));
  };
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useEffect(() => {
    const element = svg.current!;
    const resize = new ResizeObserver(() => {
      const box = element.getBoundingClientRect();
      onSize({ width: box.width, height: box.height });
      if (viewRef.current.fit) fitRef.current();
    });
    resize.observe(element);
    return () => resize.disconnect();
  }, [width, height]);
  useEffect(() => {
    if (options.fit) fit();
  }, [options.fit, width, height, bounds.x, bounds.y, bounds.width, bounds.height]);
  return fit;
}

/** Installs a non-passive wheel listener for pan and ctrl/meta zoom around the pointer. */
export function useCanvasWheel(
  svg: RefObject<SVGSVGElement | null>,
  viewRef: RefObject<CanvasView>,
  setter: ViewSetter,
  space: 'page' | 'infinite',
) {
  useEffect(() => {
    const element = svg.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = element.getBoundingClientRect();
      setter.current(wheelCanvasView(viewRef.current, e, rect, space));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);
}
