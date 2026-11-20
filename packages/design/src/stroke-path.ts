import { transaction, type Bounds, type EditorCommand } from '@editor-platform/editor-core';
import { captureDesignData } from './command-data';
import { insertDesignPath } from './path-commands';
import { updateElement, type DesignContent } from './model';
import { designPathLimits, type DesignEditablePath } from './path';

/** Follow the selected stroke's owner so consecutive strokes stay in the chosen page/group. */
export function designStrokeParent(
  content: DesignContent,
  selectedId?: string,
): string | undefined {
  if (!selectedId)
    return content.pagination?.pages[0]?.panelIds[0] ?? content.pagination?.pages[0]?.frameId;
  let element = content.elements.find((e) => e.id === selectedId);
  const visited = new Set<string>();
  while (element && !visited.has(element.id)) {
    if (element.type === 'frame' || element.type === 'group') return element.id;
    visited.add(element.id);
    element = content.elements.find((e) => e.id === element!.parentId);
  }
}

/** Uniform-width vector input only; samples become ordinary editable native anchors. */
export function designStrokePath(raw: readonly { x: number; y: number }[]): DesignEditablePath {
  const samples = captureDesignData(raw, true);
  if (!Array.isArray(samples) || samples.length < 2 || samples.length > 2048)
    throw Error('A stroke needs 2–2048 samples');
  const points: { x: number; y: number }[] = [];
  for (const p of samples) {
    if (
      !p ||
      Object.keys(p).sort().join(',') !== 'x,y' ||
      ![p.x, p.y].every(
        (v) =>
          typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= designPathLimits.coordinate,
      )
    )
      throw Error('Invalid stroke sample');
    const previous = points.at(-1);
    if (!previous || previous.x !== p.x || previous.y !== p.y) points.push(p);
  }
  if (points.length < 2) throw Error('Move the pointer to draw a stroke');
  const x = Math.min(...points.map((p) => p.x)),
    y = Math.min(...points.map((p) => p.y));
  const frame: Bounds = {
    x,
    y,
    width: Math.max(1, Math.max(...points.map((p) => p.x)) - x),
    height: Math.max(1, Math.max(...points.map((p) => p.y)) - y),
  };
  return {
    frame,
    fillRule: 'nonzero',
    subpaths: [
      {
        id: 'stroke',
        closed: false,
        anchors: points.map((p, i) => ({ id: `a${i}`, ...p, mode: 'corner' })),
        segments: points
          .slice(1)
          .map((_, i) => ({ id: `e${i}`, type: 'line', from: `a${i}`, to: `a${i + 1}` })),
      },
    ],
  };
}
export function insertDesignStroke(
  samples: readonly { x: number; y: number }[],
  parentId?: string,
  writable = () => true,
): EditorCommand<DesignContent> & { elementId: string } {
  const path = designStrokePath(samples),
    insert = insertDesignPath(path, path.frame, parentId, writable);
  return {
    ...transaction('Draw ink stroke', [
      insert,
      updateElement(insert.elementId, {
        name: 'Hand drawn stroke',
        fill: 'none',
        stroke: '#151515',
        strokeWidth: 2.5,
      }),
    ]),
    elementId: insert.elementId,
  };
}

export interface DesignBrushSample {
  x: number;
  y: number;
  /** Pen pressure 0–1. A mouse reports 0.5 while pressed, which gives an even line. */
  pressure?: number;
}
/** Widest a brush stroke may be, in world units. */
export const designBrushLimits = Object.freeze({ samples: 2000, width: 200 });

/**
 * Brush ink (#20): the stroke becomes a filled outline whose width follows pen pressure, with
 * tapered start and end (入り・抜き) so even a mouse stroke reads as a brush line. The outline is
 * an ordinary native path, editable and exported like any other.
 */
export function designBrushPath(raw: readonly DesignBrushSample[], width = 6): DesignEditablePath {
  if (!Number.isFinite(width) || width <= 0 || width > designBrushLimits.width)
    throw Error(`Brush width must be between 0 and ${designBrushLimits.width}`);
  const samples = captureDesignData(raw, true);
  if (!Array.isArray(samples) || samples.length < 2 || samples.length > designBrushLimits.samples)
    throw Error(`A brush stroke needs 2–${designBrushLimits.samples} samples`);
  const points: Required<DesignBrushSample>[] = [];
  for (const s of samples) {
    const keys = Object.keys(s ?? {})
      .sort()
      .join(',');
    if (
      !s ||
      (keys !== 'x,y' && keys !== 'pressure,x,y') ||
      ![s.x, s.y].every(
        (v) =>
          typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= designPathLimits.coordinate,
      ) ||
      (s.pressure !== undefined &&
        (typeof s.pressure !== 'number' || !(s.pressure >= 0 && s.pressure <= 1)))
    )
      throw Error('Invalid brush sample');
    const previous = points.at(-1);
    if (!previous || previous.x !== s.x || previous.y !== s.y)
      points.push({ x: s.x, y: s.y, pressure: s.pressure ?? 0.5 });
  }
  if (points.length < 2) throw Error('Move the pointer to draw a stroke');
  // Few, far apart samples (a fast stroke) get points in between, so only the ends taper and the
  // body keeps its width (Codex on #29).
  {
    let length = 0;
    for (let i = 1; i < points.length; i++)
      length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    const spacing = Math.max(
      Math.min(length / 3, width * 4) / 2,
      // Within the path's anchor limit: the outline has two anchors per point.
      length / Math.max(1, designPathLimits.anchors / 2 - points.length),
      1e-9,
    );
    const dense: Required<DesignBrushSample>[] = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const [a, b] = [points[i - 1], points[i]];
      const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / spacing);
      for (let k = 1; k < n; k++)
        if (dense.length < designPathLimits.anchors / 2 - (points.length - i))
          dense.push({
            x: a.x + ((b.x - a.x) * k) / n,
            y: a.y + ((b.y - a.y) * k) / n,
            pressure: a.pressure + ((b.pressure - a.pressure) * k) / n,
          });
      dense.push(b);
    }
    points.splice(0, points.length, ...dense);
  }
  // Distance along the stroke drives the taper; pressure is smoothed so a jittery pen stays clean.
  const along = [0];
  for (let i = 1; i < points.length; i++)
    along.push(
      along[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y),
    );
  const total = along.at(-1)!;
  const taper = Math.min(total / 3, width * 4);
  let smooth = points[0].pressure;
  const half = points.map((p, i) => {
    smooth = smooth * 0.6 + p.pressure * 0.4;
    const ends = Math.min(1, along[i] / taper, (total - along[i]) / taper);
    return (width / 2) * (0.3 + 1.4 * smooth) * Math.max(0.08, Math.sqrt(Math.max(0, ends)));
  });
  const left: { x: number; y: number }[] = [],
    right: { x: number; y: number }[] = [];
  points.forEach((p, i) => {
    const a = points[Math.max(0, i - 1)],
      b = points[Math.min(points.length - 1, i + 1)];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / len,
      ny = (b.x - a.x) / len;
    left.push({ x: p.x + nx * half[i], y: p.y + ny * half[i] });
    right.push({ x: p.x - nx * half[i], y: p.y - ny * half[i] });
  });
  const outline = [...left, ...right.reverse()];
  const x = Math.min(...outline.map((p) => p.x)),
    y = Math.min(...outline.map((p) => p.y));
  return {
    frame: {
      x,
      y,
      width: Math.max(1, Math.max(...outline.map((p) => p.x)) - x),
      height: Math.max(1, Math.max(...outline.map((p) => p.y)) - y),
    },
    fillRule: 'nonzero',
    subpaths: [
      {
        id: 'brush',
        closed: true,
        anchors: outline.map((p, i) => ({ id: `a${i}`, ...p, mode: 'corner' })),
        segments: outline.map((_, i) => ({
          id: `e${i}`,
          type: 'line',
          from: `a${i}`,
          to: `a${(i + 1) % outline.length}`,
        })),
      },
    ],
  };
}
export function insertDesignBrushStroke(
  samples: readonly DesignBrushSample[],
  parentId?: string,
  width = 6,
  writable = () => true,
): EditorCommand<DesignContent> & { elementId: string } {
  const path = designBrushPath(samples, width),
    insert = insertDesignPath(path, path.frame, parentId, writable);
  return {
    ...transaction('Draw brush stroke', [
      insert,
      updateElement(insert.elementId, { name: 'Brush stroke', fill: '#151515', stroke: 'none' }),
    ]),
    elementId: insert.elementId,
  };
}
