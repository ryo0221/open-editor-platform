import { arcOf, loopEdges, type PcbLoop, type Vec2 } from '@editor-platform/pcb-core';

/**
 * Pure 2D view math for the board Surface (PB1). The board's plan has y up; SVG has y down, so
 * the SVG draws at (x, −y). A view is the board point at the viewport's centre and the scale.
 */
export interface PcbView {
  /** Board point (mm) at the viewport's centre. */
  center: Vec2;
  /** Screen pixels per millimetre. */
  pxPerMm: number;
}
export const pcbViewLimits = Object.freeze({ minPxPerMm: 0.05, maxPxPerMm: 2000 });
const clampScale = (s: number) =>
  Math.min(pcbViewLimits.maxPxPerMm, Math.max(pcbViewLimits.minPxPerMm, s));

/** A view that shows `bounds` (`[minX, minY, maxX, maxY]`) with a margin of `marginPx`. */
export function fitPcbView(
  bounds: readonly [number, number, number, number],
  size: { width: number; height: number },
  marginPx = 32,
): PcbView {
  const w = Math.max(bounds[2] - bounds[0], 1e-3);
  const h = Math.max(bounds[3] - bounds[1], 1e-3);
  const sx = Math.max(size.width - 2 * marginPx, 1) / w;
  const sy = Math.max(size.height - 2 * marginPx, 1) / h;
  return {
    center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
    pxPerMm: clampScale(Math.min(sx, sy)),
  };
}
/** Board point under a screen point (relative to the viewport's top-left). */
export function screenToBoard(
  view: PcbView,
  size: { width: number; height: number },
  px: Vec2,
): Vec2 {
  return [
    view.center[0] + (px[0] - size.width / 2) / view.pxPerMm,
    view.center[1] - (px[1] - size.height / 2) / view.pxPerMm,
  ];
}
export function boardToScreen(
  view: PcbView,
  size: { width: number; height: number },
  p: Vec2,
): Vec2 {
  return [
    size.width / 2 + (p[0] - view.center[0]) * view.pxPerMm,
    size.height / 2 - (p[1] - view.center[1]) * view.pxPerMm,
  ];
}
/** Zooms by `factor` keeping the board point under `px` in place. */
export function zoomPcbView(
  view: PcbView,
  size: { width: number; height: number },
  px: Vec2,
  factor: number,
): PcbView {
  const anchor = screenToBoard(view, size, px);
  const pxPerMm = clampScale(view.pxPerMm * factor);
  return {
    pxPerMm,
    center: [
      anchor[0] - (px[0] - size.width / 2) / pxPerMm,
      anchor[1] + (px[1] - size.height / 2) / pxPerMm,
    ],
  };
}
/** The SVG viewBox (in SVG units = mm, y flipped) the view shows. */
export function pcbViewBox(view: PcbView, size: { width: number; height: number }) {
  const w = size.width / view.pxPerMm;
  const h = size.height / view.pxPerMm;
  return [view.center[0] - w / 2, -view.center[1] - h / 2, w, h] as const;
}

/** Grid steps offered, in mm (2.54 mm = 0.1 in, the usual header pitch). */
export const pcbGridSteps = [0.05, 0.1, 0.25, 0.5, 1, 1.27, 2.54, 5, 10] as const;
/** Snaps a point to the grid of `step` from the origin; rounds away float noise to 1 nm. */
export function snapToGrid(p: Vec2, step: number): Vec2 {
  // `+ 0` turns -0 (a click just below an axis) into 0.
  const s = (v: number) => Math.round(Math.round(v / step) * step * 1e6) / 1e6 + 0;
  return [s(p[0]), s(p[1])];
}
/** The drawn grid step: `step` times a power of 2 large enough to be `minPx` apart on screen. */
export function drawnGridStep(step: number, pxPerMm: number, minPx = 8): number {
  let s = step;
  while (s * pxPerMm < minPx) s *= 2;
  return s;
}

/** An SVG path of closed loops in board millimetres (y flipped), exact along arcs. */
export function loopsPath(loops: readonly PcbLoop[]): string {
  const f = (v: number) => String(Math.round(v * 1e6) / 1e6);
  return loops
    .map((loop) => {
      const edges = loopEdges(loop);
      let d = `M${f(edges[0].p[0])} ${f(-edges[0].p[1])}`;
      for (const e of edges) {
        if (!e.arc) {
          d += `L${f(e.q[0])} ${f(-e.q[1])}`;
          continue;
        }
        const arc = arcOf(e.p, e.q, Math.tan(e.arc.sweep / 4));
        const large = Math.abs(arc.sweep) > Math.PI ? 1 : 0;
        // Counter-clockwise in the plan is clockwise once y is flipped (SVG sweep flag 0).
        const sweep = arc.sweep > 0 ? 0 : 1;
        d += `A${f(arc.radius)} ${f(arc.radius)} 0 ${large} ${sweep} ${f(e.q[0])} ${f(-e.q[1])}`;
      }
      return `${d}Z`;
    })
    .join('');
}
