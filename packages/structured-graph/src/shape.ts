import { type Bounds, type Point } from '@editor-platform/editor-core';
import {
  type GraphDocument,
  type GraphNode,
  type GraphNodeShape,
  type GraphNodeStyle,
  type GraphSection,
} from './model';
import { type GraphProfile } from './profile';

/**
 * Pure outline geometry for node shapes, shared by the Surface, routing, hit testing and the
 * reference SVG renderer. Curves are flattened to fixed point counts so results are stable.
 */
export interface GraphShapeMetrics {
  /** Horizontal label inset on each side, as a fraction of the width. */
  insetX: number;
  /** Fraction of the height the label may use. */
  heightRatio: number;
  /** Extra height in logical pixels the outline needs beyond the label (cylinder caps). */
  extraHeight: number;
  /** Half the span, as a fraction of a side, in which parallel connection ports may sit. */
  portRange: number;
}
const metrics: Record<GraphNodeShape, GraphShapeMetrics> = {
  rectangle: { insetX: 0, heightRatio: 1, extraHeight: 0, portRange: 0.5 },
  'rounded-rectangle': { insetX: 0.04, heightRatio: 0.93, extraHeight: 0, portRange: 0.45 },
  ellipse: { insetX: 0.146, heightRatio: 0.71, extraHeight: 0, portRange: 0.35 },
  diamond: { insetX: 0.25, heightRatio: 0.5, extraHeight: 0, portRange: 0.25 },
  hexagon: { insetX: 0.15, heightRatio: 1, extraHeight: 0, portRange: 0.35 },
  cylinder: { insetX: 0.04, heightRatio: 1, extraHeight: 30, portRange: 0.45 },
  cloud: { insetX: 0.19, heightRatio: 0.62, extraHeight: 0, portRange: 0.3 },
};
export const graphShapeMetrics = (shape: GraphNodeShape): GraphShapeMetrics => metrics[shape];

const arc = (cx: number, cy: number, rx: number, ry: number, from: number, to: number, n: number) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const t = from + ((to - from) * i) / n;
    return { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) };
  });
/** Cylinder cap height: a fixed size so the auto height does not depend on itself. */
export const graphCylinderCap = (box: Bounds) => Math.min(10, box.height * 0.15);

/** The closed outline, clockwise from the top-left in screen coordinates. */
export function graphShapePolygon(shape: GraphNodeShape, box: Bounds): Point[] {
  const { x, y, width: w, height: h } = box,
    cx = x + w / 2,
    cy = y + h / 2;
  switch (shape) {
    case 'rectangle':
      return [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ];
    case 'rounded-rectangle': {
      const r = Math.min(12, w / 4, h / 4);
      return [
        ...arc(x + r, y + r, r, r, Math.PI, Math.PI * 1.5, 6),
        ...arc(x + w - r, y + r, r, r, Math.PI * 1.5, Math.PI * 2, 6),
        ...arc(x + w - r, y + h - r, r, r, 0, Math.PI / 2, 6),
        ...arc(x + r, y + h - r, r, r, Math.PI / 2, Math.PI, 6),
      ];
    }
    case 'ellipse':
      return arc(cx, cy, w / 2, h / 2, Math.PI, Math.PI * 3, 64).slice(0, -1);
    case 'diamond':
      return [
        { x: cx, y },
        { x: x + w, y: cy },
        { x: cx, y: y + h },
        { x, y: cy },
      ];
    case 'hexagon': {
      const d = w * 0.15;
      return [
        { x: x + d, y },
        { x: x + w - d, y },
        { x: x + w, y: cy },
        { x: x + w - d, y: y + h },
        { x: x + d, y: y + h },
        { x, y: cy },
      ];
    }
    case 'cylinder': {
      const ry = graphCylinderCap(box);
      // Silhouette: the top cap's upper arc, the right side, the base's lower arc, the left side.
      return [
        ...arc(cx, y + ry, w / 2, ry, Math.PI, Math.PI * 2, 24),
        ...arc(cx, y + h - ry, w / 2, ry, 0, Math.PI, 24),
      ];
    }
    case 'cloud':
      return Array.from({ length: 96 }, (_, i) => {
        const t = Math.PI + (Math.PI * 2 * i) / 96,
          // Eight lobes that reach the bounds at the four side midpoints.
          k = 0.88 + 0.12 * Math.abs(Math.cos(4 * t));
        return { x: cx + (w / 2) * k * Math.cos(t), y: cy + (h / 2) * k * Math.sin(t) };
      });
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
/** SVG path for drawing. The cylinder adds the front rim of its top cap as an open stroke. */
export function graphShapePath(shape: GraphNodeShape, box: Bounds): string {
  const points = graphShapePolygon(shape, box);
  let path = points.map((p, i) => `${i ? 'L' : 'M'}${round(p.x)},${round(p.y)}`).join(' ') + ' Z';
  if (shape === 'cylinder') {
    const ry = graphCylinderCap(box);
    path += ` M${round(box.x)},${round(box.y + ry)} A${round(box.width / 2)},${round(ry)} 0 0 0 ${round(box.x + box.width)},${round(box.y + ry)}`;
  }
  return path;
}

/** The rectangle in which the label is laid out. */
export function graphShapeContentBox(shape: GraphNodeShape, box: Bounds): Bounds {
  const m = metrics[shape],
    top = shape === 'cylinder' ? graphCylinderCap(box) * 2 : (box.height * (1 - m.heightRatio)) / 2,
    bottom = shape === 'cylinder' ? graphCylinderCap(box) : top;
  return {
    x: box.x + box.width * m.insetX,
    y: box.y + top,
    width: box.width * (1 - m.insetX * 2),
    height: Math.max(0, box.height - top - bottom),
  };
}

/** The height a node needs so a label of `labelHeight` fits in its content box. */
export function graphShapeHeight(shape: GraphNodeShape, labelHeight: number, minimum = 70) {
  const m = metrics[shape];
  return Math.max(minimum, Math.ceil(labelHeight / m.heightRatio + m.extraHeight));
}

export function graphShapeContains(shape: GraphNodeShape, box: Bounds, point: Point): boolean {
  const polygon = graphShapePolygon(shape, box);
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

/**
 * Where a connection meets the outline: from `port` on the bounding box, along the inward
 * normal `inward`, the first outline crossing. Falls back to the port when none is found.
 */
export function graphShapeEndpoint(
  shape: GraphNodeShape,
  box: Bounds,
  port: Point,
  inward: Point,
): Point {
  if (shape === 'rectangle') return port;
  const polygon = graphShapePolygon(shape, box);
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length],
      ex = b.x - a.x,
      ey = b.y - a.y,
      denominator = inward.x * ey - inward.y * ex;
    if (Math.abs(denominator) < 1e-9) continue;
    const t = ((a.x - port.x) * ey - (a.y - port.y) * ex) / denominator,
      u = ((a.x - port.x) * inward.y - (a.y - port.y) * inward.x) / denominator;
    if (t >= -1e-6 && u >= -1e-9 && u <= 1 + 1e-9 && t < best) best = t;
  }
  return Number.isFinite(best)
    ? { x: port.x + inward.x * Math.max(0, best), y: port.y + inward.y * Math.max(0, best) }
    : port;
}

const fallbackFill = '#ffffff',
  fallbackStroke = '#94a3b8';
export interface GraphNodeLook {
  shape: GraphNodeShape;
  style: GraphNodeStyle;
}
/** Node override first, then the Profile type default, then a plain rectangle; per style field. */
export function resolveGraphNodeLook(
  graph: GraphDocument,
  profile: GraphProfile,
  node: GraphNode,
): GraphNodeLook {
  const saved = graph.presentation.nodes[node.id],
    ui = profile.nodes[node.type]?.ui;
  return {
    shape: saved?.shape ?? ui?.shape ?? 'rectangle',
    style: { ...ui?.style, ...saved?.style },
  };
}
/** A Section's own style over its Profile type default, per field. */
export function resolveGraphSectionStyle(
  graph: GraphDocument,
  profile: GraphProfile,
  section: GraphSection,
): GraphNodeStyle {
  return {
    ...profile.sections[section.type]?.ui?.style,
    ...graph.presentation.sections[section.id]?.style,
  };
}

const channel = (hex: string, i: number) => {
  const full =
    hex.length === 4
      ? hex
          .slice(1)
          .split('')
          .map((c) => c + c)
          .join('')
      : hex.slice(1);
  const v = parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) =>
  0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
/**
 * Black or white label text, whichever contrasts more with the fill. With pure black and white
 * the better of the two is at least 4.58:1 for every fill, so any declared hex stays legible.
 */
export function graphLabelColor(fill: string | undefined): '#000000' | '#ffffff' {
  const background = luminance(fill ?? fallbackFill);
  return contrast(background, 0) >= contrast(background, 1) ? '#000000' : '#ffffff';
}
export const graphShapeFill = (style: GraphNodeStyle) => style.fill ?? fallbackFill;
export const graphShapeStroke = (style: GraphNodeStyle) => style.stroke ?? fallbackStroke;
