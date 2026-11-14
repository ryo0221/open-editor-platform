import {
  partDrawPoint,
  type SchematicPart,
  type SchematicPinSide,
  type SchematicSymbol,
  type Vec2,
} from '@editor-platform/schematic-core';

/**
 * Pure 2D view math for the schematic Surface (SL1). The sheet has y down, like SVG, so sheet
 * millimetres are SVG units. A view is the sheet point at the viewport's centre and the scale.
 */
export interface SchematicView {
  center: Vec2;
  pxPerMm: number;
}
export const schematicViewLimits = Object.freeze({ minPxPerMm: 0.2, maxPxPerMm: 200 });
const clampScale = (s: number) =>
  Math.min(schematicViewLimits.maxPxPerMm, Math.max(schematicViewLimits.minPxPerMm, s));
type Size = { width: number; height: number };

export function fitSchematicView(
  bounds: readonly [number, number, number, number],
  size: Size,
  marginPx = 24,
): SchematicView {
  const w = Math.max(bounds[2] - bounds[0], 1e-3);
  const h = Math.max(bounds[3] - bounds[1], 1e-3);
  const sx = Math.max(size.width - 2 * marginPx, 1) / w;
  const sy = Math.max(size.height - 2 * marginPx, 1) / h;
  return {
    center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
    pxPerMm: clampScale(Math.min(sx, sy)),
  };
}
export function screenToSheet(view: SchematicView, size: Size, px: Vec2): Vec2 {
  return [
    view.center[0] + (px[0] - size.width / 2) / view.pxPerMm,
    view.center[1] + (px[1] - size.height / 2) / view.pxPerMm,
  ];
}
export function sheetToScreen(view: SchematicView, size: Size, p: Vec2): Vec2 {
  return [
    size.width / 2 + (p[0] - view.center[0]) * view.pxPerMm,
    size.height / 2 + (p[1] - view.center[1]) * view.pxPerMm,
  ];
}
/** Zooms by `factor` keeping the sheet point under `px` in place. */
export function zoomSchematicView(
  view: SchematicView,
  size: Size,
  px: Vec2,
  factor: number,
): SchematicView {
  const anchor = screenToSheet(view, size, px);
  const pxPerMm = clampScale(view.pxPerMm * factor);
  return {
    pxPerMm,
    center: [
      anchor[0] - (px[0] - size.width / 2) / pxPerMm,
      anchor[1] - (px[1] - size.height / 2) / pxPerMm,
    ],
  };
}
export function schematicViewBox(view: SchematicView, size: Size) {
  const w = size.width / view.pxPerMm;
  const h = size.height / view.pxPerMm;
  return [view.center[0] - w / 2, view.center[1] - h / 2, w, h] as const;
}

const sideStep: Record<SchematicPinSide, Vec2> = {
  right: [1, 0],
  left: [-1, 0],
  up: [0, -1],
  down: [0, 1],
};
/** A pin's line in the symbol frame: from its connection end into the body. */
export function pinLine(pin: SchematicSymbol['pins'][number]): [Vec2, Vec2] {
  const d = sideStep[pin.side];
  return [pin.at, [pin.at[0] + d[0] * pin.lengthMm, pin.at[1] + d[1] * pin.lengthMm]];
}

/** Every symbol-frame point the symbol draws (graphics and pins), for its box. */
function symbolPoints(symbol: SchematicSymbol): Vec2[] {
  const pts: Vec2[] = [];
  for (const g of symbol.graphics) {
    if (g.kind === 'line' || g.kind === 'polygon') pts.push(...g.points);
    else if (g.kind === 'rect') pts.push(g.from, g.to);
    else if (g.kind === 'circle')
      pts.push(
        [g.center[0] - g.radiusMm, g.center[1] - g.radiusMm],
        [g.center[0] + g.radiusMm, g.center[1] + g.radiusMm],
      );
    else pts.push(g.at);
  }
  for (const pin of symbol.pins) pts.push(...pinLine(pin));
  return pts;
}
/** The placed part's box on the sheet `[minX, minY, maxX, maxY]`. */
export function partBox(part: SchematicPart, symbol: SchematicSymbol) {
  const pts = symbolPoints(symbol).map((p) => partDrawPoint(part, p));
  if (!pts.length) return [part.at[0], part.at[1], part.at[0], part.at[1]] as const;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as const;
}

/** Distance from `p` to the segment a–b. */
export function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * The points a wire tool adds from `from` to `to`: straight when they share a row or column,
 * else horizontal first, then vertical.
 */
export function wireLeg(from: Vec2, to: Vec2): Vec2[] {
  if (from[0] === to[0] && from[1] === to[1]) return [];
  if (from[0] === to[0] || from[1] === to[1]) return [to];
  return [[to[0], from[1]], to];
}
