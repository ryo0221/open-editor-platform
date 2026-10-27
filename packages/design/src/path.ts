import {
  boundsBezier3,
  bezierCoordinateLimit,
  type BezierPoint,
  type Bezier3,
} from '@editor-platform/geometry-core/bezier';
import type { Bounds, Drawing } from '@editor-platform/editor-core';
import { designId } from './command-data';

export interface DesignPathAnchor {
  id: string;
  x: number;
  y: number;
  mode: 'corner' | 'smooth' | 'symmetric';
}
export type DesignPathSegment = { id: string; from: string; to: string } & (
  | { type: 'line' }
  | { type: 'cubic'; c1: { x: number; y: number }; c2: { x: number; y: number } }
);
export interface DesignEditablePath {
  frame: Bounds;
  fillRule: 'nonzero' | 'evenodd';
  subpaths: {
    id: string;
    closed: boolean;
    anchors: DesignPathAnchor[];
    segments: DesignPathSegment[];
  }[];
}
export const designPathLimits = Object.freeze({
  subpaths: 128,
  anchors: 4096,
  segments: 4096,
  totalAnchors: 16384,
  totalSegments: 16384,
  bytes: 8 * 1024 * 1024,
  coordinate: 1_000_000,
});
function object(v: unknown): v is Record<string, unknown> {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(v)) &&
    Object.getOwnPropertySymbols(v).length === 0 &&
    Object.values(Object.getOwnPropertyDescriptors(v)).every((d) => 'value' in d && d.enumerable)
  );
}
function plainArray(v: unknown, limit: number): v is unknown[] {
  if (!Array.isArray(v) || v.length > limit || Object.getOwnPropertySymbols(v).length) return false;
  const fields = Object.entries(Object.getOwnPropertyDescriptors(v)).filter(
    ([k]) => k !== 'length',
  );
  return (
    fields.length === v.length &&
    fields.every(([k, d], i) => k === String(i) && 'value' in d && d.enumerable)
  );
}
function keys(v: Record<string, unknown>, fields: string[]) {
  return Object.keys(v).every((k) => fields.includes(k));
}
const number = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= designPathLimits.coordinate;
const point = (v: unknown): v is { x: number; y: number } =>
  object(v) && keys(v, ['x', 'y']) && number(v.x) && number(v.y);
/** Strict structured-path reader. Mode is an editing policy, never a load-time shape correction. */
export function validDesignPath(value: unknown): value is DesignEditablePath {
  try {
    if (!object(value) || !keys(value, ['frame', 'fillRule', 'subpaths'])) return false;
    const p = value as unknown as DesignEditablePath,
      f = p.frame;
    if (
      !object(f) ||
      !keys(f, ['x', 'y', 'width', 'height']) ||
      ![f.x, f.y, f.width, f.height].every(number) ||
      f.width <= 0 ||
      f.height <= 0 ||
      !['nonzero', 'evenodd'].includes(p.fillRule) ||
      !plainArray(p.subpaths, 128) ||
      !p.subpaths.length ||
      p.subpaths.length > 128
    )
      return false;
    const ids = new Set<string>();
    const id = (v: unknown) => {
      designId(v);
      if (ids.has(v)) throw Error();
      ids.add(v);
    };
    let anchors = 0,
      segments = 0;
    for (const s of p.subpaths) {
      if (
        !object(s) ||
        !keys(s, ['id', 'closed', 'anchors', 'segments']) ||
        typeof s.closed !== 'boolean' ||
        !plainArray(s.anchors, 4096) ||
        !plainArray(s.segments, 4096) ||
        !s.segments.length
      )
        return false;
      id(s.id);
      anchors += s.anchors.length;
      segments += s.segments.length;
      if (
        anchors > 4096 ||
        segments > 4096 ||
        s.segments.length !== s.anchors.length - (s.closed ? 0 : 1)
      )
        return false;
      for (const a of s.anchors) {
        if (
          !object(a) ||
          !keys(a, ['id', 'x', 'y', 'mode']) ||
          !number(a.x) ||
          !number(a.y) ||
          !['corner', 'smooth', 'symmetric'].includes(a.mode)
        )
          return false;
        id(a.id);
      }
      for (const [i, e] of s.segments.entries()) {
        if (
          !object(e) ||
          !keys(
            e,
            e.type === 'line'
              ? ['id', 'type', 'from', 'to']
              : ['id', 'type', 'from', 'to', 'c1', 'c2'],
          ) ||
          !['line', 'cubic'].includes(e.type) ||
          e.from !== s.anchors[i].id ||
          e.to !== s.anchors[(i + 1) % s.anchors.length].id
        )
          return false;
        id(e.id);
        if (e.type === 'cubic' && (!point(e.c1) || !point(e.c2))) return false;
      }
    }
    return new TextEncoder().encode(JSON.stringify(p)).length <= designPathLimits.bytes;
  } catch {
    return false;
  }
}
/** Fixed local frame -> element frame; rotation and flips are around the element centre. */
export function designPathPoint(
  path: DesignEditablePath,
  drawing: Pick<Drawing, 'bounds' | 'rotation' | 'flipX' | 'flipY'>,
  p: { x: number; y: number },
  inverse = false,
): { x: number; y: number } {
  const b = drawing.bounds,
    f = path.frame,
    cx = b.x + b.width / 2,
    cy = b.y + b.height / 2,
    angle = ((drawing.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle),
    sin = Math.sin(angle),
    fx = drawing.flipX ? -1 : 1,
    fy = drawing.flipY ? -1 : 1;
  if (inverse) {
    const x = p.x - cx,
      y = p.y - cy;
    return {
      x: f.x + (((cos * x + sin * y) * fx + b.width / 2) * f.width) / b.width,
      y: f.y + (((-sin * x + cos * y) * fy + b.height / 2) * f.height) / b.height,
    };
  }
  const x = (((p.x - f.x) * b.width) / f.width - b.width / 2) * fx,
    y = (((p.y - f.y) * b.height) / f.height - b.height / 2) * fy;
  return { x: cx + cos * x - sin * y, y: cy + sin * x + cos * y };
}
/** Refuse transforms whose projected coordinates cannot be evaluated safely. */
export function projectableDesignPath(
  path: DesignEditablePath,
  drawing: Pick<Drawing, 'bounds' | 'rotation' | 'flipX' | 'flipY' | 'strokeWidth'>,
): boolean {
  const b = drawing.bounds,
    f = path.frame;
  if (
    ![b.x, b.y, b.width, b.height, drawing.rotation ?? 0].every(Number.isFinite) ||
    b.width <= 0 ||
    b.height <= 0
  )
    return false;
  const finite = (v: number) => Number.isFinite(v) && Math.abs(v) <= bezierCoordinateLimit;
  if (!finite(drawing.strokeWidth ?? 2)) return false;
  return path.subpaths.every((s) =>
    [...s.anchors, ...s.segments.flatMap((e) => (e.type === 'cubic' ? [e.c1, e.c2] : []))].every(
      (p) => {
        const world = designPathPoint(path, drawing, p);
        return [
          world.x,
          world.y,
          b.x + ((p.x - f.x) * b.width) / f.width,
          b.y + ((p.y - f.y) * b.height) / f.height,
        ].every(finite);
      },
    ),
  );
}
/** Rendering-only DTO; no native IDs, modes, local-frame clip or aspect-fit. */
export function projectDesignPath(
  path: DesignEditablePath,
  drawing: Pick<Drawing, 'bounds' | 'rotation' | 'flipX' | 'flipY' | 'strokeWidth'>,
): NonNullable<Drawing['path']> {
  if (!validDesignPath(path)) throw Error('Invalid Design path');
  if (!projectableDesignPath(path, drawing)) throw Error('Unsupported Design path transform');
  const b = drawing.bounds,
    f = path.frame;
  const unrotated = (p: { x: number; y: number }) =>
    `${b.x + ((p.x - f.x) * b.width) / f.width} ${b.y + ((p.y - f.y) * b.height) / f.height}`;
  const world = (p: { x: number; y: number }): BezierPoint => {
    const q = designPathPoint(path, drawing, p);
    return [q.x, q.y];
  };
  const boxes: { min: BezierPoint; max: BezierPoint }[] = [];
  const data = path.subpaths
    .map((s) => {
      const commands = [`M${unrotated(s.anchors[0])}`];
      for (const [i, e] of s.segments.entries()) {
        const from = s.anchors[i],
          to = s.anchors[(i + 1) % s.anchors.length];
        commands.push(
          e.type === 'line'
            ? `L${unrotated(to)}`
            : `C${unrotated(e.c1)} ${unrotated(e.c2)} ${unrotated(to)}`,
        );
        if (e.type === 'cubic')
          boxes.push(boundsBezier3([world(from), world(e.c1), world(e.c2), world(to)] as Bezier3));
        else {
          const a = world(from),
            b = world(to);
          boxes.push({
            min: [Math.min(a[0], b[0]), Math.min(a[1], b[1])],
            max: [Math.max(a[0], b[0]), Math.max(a[1], b[1])],
          });
        }
      }
      if (s.closed) commands.push('Z');
      return commands.join(' ');
    })
    .join(' ');
  const pad = (drawing.strokeWidth ?? 2) / 2;
  const minX = Math.min(...boxes.map((b) => b.min[0])) - pad,
    minY = Math.min(...boxes.map((b) => b.min[1])) - pad;
  return {
    d: data,
    fillRule: path.fillRule,
    paintBounds: {
      x: minX,
      y: minY,
      width: Math.max(...boxes.map((b) => b.max[0])) + pad - minX,
      height: Math.max(...boxes.map((b) => b.max[1])) + pad - minY,
    },
  };
}
