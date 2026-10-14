import {
  attribute,
  child,
  namespaces as ns,
  ImportError,
  type XmlNode,
} from '@editor-platform/office-import-core';
import type { Bounds } from '@editor-platform/editor-core';
export type Matrix = readonly [number, number, number, number, number, number];
export const identity: Matrix = [1, 0, 0, 1, 0, 0];
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
export function numeric(node: XmlNode | undefined, name: string, fallback?: number) {
  const raw = attribute(node, name);
  if (raw === undefined && fallback !== undefined) return fallback;
  if (raw === undefined || !/^-?\d+(\.\d+)?$/.test(raw) || !Number.isFinite(Number(raw)))
    throw new ImportError('INVALID_GEOMETRY', `Invalid ${name}`);
  return Number(raw);
}
const translation = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
export function transform(node: XmlNode, group = false) {
  const off = child(node, 'off', ns.a),
    ext = child(node, 'ext', ns.a);
  const x = numeric(off, 'x') / 9525,
    y = numeric(off, 'y') / 9525,
    w = numeric(ext, 'cx') / 9525,
    h = numeric(ext, 'cy') / 9525;
  if (w < 0 || h < 0 || Math.max(Math.abs(x), Math.abs(y), w, h) > 1e6)
    throw new ImportError('INVALID_GEOMETRY', 'Out-of-range object bounds');
  const angle = ((numeric(node, 'rot', 0) / 60000) * Math.PI) / 180,
    fx = attribute(node, 'flipH') === '1' || attribute(node, 'flipH') === 'true' ? -1 : 1,
    fy = attribute(node, 'flipV') === '1' || attribute(node, 'flipV') === 'true' ? -1 : 1;
  const rotation: Matrix = [
    Math.cos(angle) * fx,
    Math.sin(angle) * fx,
    -Math.sin(angle) * fy,
    Math.cos(angle) * fy,
    0,
    0,
  ];
  const local = multiply(
    multiply(translation(x + w / 2, y + h / 2), rotation),
    translation(-w / 2, -h / 2),
  );
  if (!group) return { matrix: local, width: w, height: h };
  const co = child(node, 'chOff', ns.a),
    ce = child(node, 'chExt', ns.a),
    cw = numeric(ce, 'cx') / 9525,
    ch = numeric(ce, 'cy') / 9525;
  if (cw <= 0 || ch <= 0 || w <= 0 || h <= 0)
    throw new ImportError('INVALID_GEOMETRY', 'Empty group coordinate system');
  return {
    matrix: multiply(
      local,
      multiply(
        [w / cw, 0, 0, h / ch, 0, 0],
        translation(-numeric(co, 'x') / 9525, -numeric(co, 'y') / 9525),
      ),
    ),
    width: w,
    height: h,
  };
}
export function worldBox(
  matrix: Matrix,
  width: number,
  height: number,
):
  | { bounds: Bounds; rotation: number; flipY: boolean; scaleX: number; scaleY: number }
  | undefined {
  const sx = Math.hypot(matrix[0], matrix[1]),
    sy = Math.hypot(matrix[2], matrix[3]);
  if (
    sx === 0 ||
    sy === 0 ||
    Math.abs(matrix[0] * matrix[2] + matrix[1] * matrix[3]) > 1e-7 * sx * sy
  )
    return undefined;
  const w = width * sx,
    h = height * sy,
    cx = (matrix[0] * width) / 2 + (matrix[2] * height) / 2 + matrix[4],
    cy = (matrix[1] * width) / 2 + (matrix[3] * height) / 2 + matrix[5];
  return {
    bounds: { x: cx - w / 2, y: cy - h / 2, width: Math.max(0.001, w), height: Math.max(0.001, h) },
    rotation: (Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI,
    flipY: matrix[0] * matrix[3] - matrix[1] * matrix[2] < 0,
    scaleX: sx,
    scaleY: sy,
  };
}
