import {
  parameterValues,
  resolveLength,
  rotateVector,
  sketchElement,
  sketchElementPoints,
  type CadDocument,
  type CadSketch,
  type Quaternion,
  type Vec3,
} from '@editor-platform/cad-core';
import type { CadMesh } from '@editor-platform/cad-kernel-occt';

/**
 * CLF1a (docs/cad/car-look-process.md, CLF1〜CLF3の分け方): what a sketch is drawn over. The
 * shown bodies' display triangles and the other sketches' elements, projected along the sketch's
 * normal into its (u, v). Display only: never stored, never snapped to.
 */
export interface CadSketchUnderlay {
  /**
   * Per shown body, its triangles as u, v triples (6 numbers a triangle), each counter-clockwise
   * in (u, v): a solid's front and back faces project with opposite windings, and one winding
   * lets a single nonzero fill paint their union (#1112 review). Full precision: a body far from
   * the sketch's origin keeps its small triangles.
   */
  shadows: { bodyId: string; triangles: Float64Array }[];
  /** Per other sketch's element, its points in (u, v). */
  lines: { sketchId: string; element: string; points: [number, number][] }[];
  /** The (u, v) box everything covers, or undefined when there is nothing. */
  bounds?: [number, number, number, number];
}

type Frame = { origin: Vec3; orientation: Quaternion };
const conjugate = (q: Quaternion): Quaternion => [-q[0], -q[1], -q[2], q[3]];

/**
 * A datum plane's frame in mm, or undefined for a sketch on a face (its frame is only known to
 * the kernel's evaluation; such a sketch has no underlay).
 */
function frameOf(doc: CadDocument, sketch: CadSketch): Frame | undefined {
  if ('face' in sketch.plane) return undefined;
  const values = parameterValues(doc);
  return {
    origin: sketch.plane.origin.map((l) => resolveLength(l, values)) as Vec3,
    orientation: sketch.plane.orientation,
  };
}

/**
 * The underlay of `sketch`: the bodies in `shown` from `meshes` (the standard display meshes; a
 * coarse LOD or a shape before a failure is left out) and every other sketch on a datum plane.
 * Undefined when the sketch lies on a face.
 */
export function sketchUnderlay(
  doc: CadDocument,
  sketch: CadSketch,
  meshes: readonly CadMesh[],
  shown: ReadonlySet<string>,
): CadSketchUnderlay | undefined {
  const frame = frameOf(doc, sketch);
  if (!frame) return undefined;
  const inverse = conjugate(frame.orientation);
  const toUv = (x: number, y: number, z: number): [number, number] => {
    const p = rotateVector(inverse, [
      x - frame.origin[0],
      y - frame.origin[1],
      z - frame.origin[2],
    ]);
    return [p[0], p[1]];
  };
  let box: [number, number, number, number] | undefined;
  const grow = (u: number, v: number) => {
    if (!box) box = [u, v, u, v];
    else box = [Math.min(box[0], u), Math.min(box[1], v), Math.max(box[2], u), Math.max(box[3], v)];
  };
  const shadows: CadSketchUnderlay['shadows'] = [];
  for (const mesh of meshes) {
    if (mesh.lod || mesh.beforeFailure || !shown.has(mesh.bodyId)) continue;
    const { positions: p, indices, origin: o } = mesh;
    const uv = new Float64Array(indices.length * 2);
    // Each node once, then the triangles from the projected nodes.
    const nodes = new Float64Array((p.length / 3) * 2);
    for (let i = 0; i < p.length / 3; i++) {
      const [u, v] = toUv(p[3 * i]! + o[0], p[3 * i + 1]! + o[1], p[3 * i + 2]! + o[2]);
      nodes[2 * i] = u;
      nodes[2 * i + 1] = v;
      grow(u, v);
    }
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const [a, b, c] = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
      const ax = nodes[2 * a]!;
      const ay = nodes[2 * a + 1]!;
      const area =
        (nodes[2 * b]! - ax) * (nodes[2 * c + 1]! - ay) -
        (nodes[2 * c]! - ax) * (nodes[2 * b + 1]! - ay);
      // Clockwise in (u, v): its last two corners swapped.
      const order = area < 0 ? [a, c, b] : [a, b, c];
      order.forEach((n, k) => {
        uv[2 * (t + k)] = nodes[2 * n]!;
        uv[2 * (t + k) + 1] = nodes[2 * n + 1]!;
      });
    }
    shadows.push({ bodyId: mesh.bodyId, triangles: uv });
  }
  const lines: CadSketchUnderlay['lines'] = [];
  for (const other of doc.sketches) {
    if (other.id === sketch.id) continue;
    const at = frameOf(doc, other);
    if (!at) continue;
    for (const entity of other.entities) {
      if (entity.type === 'point') continue;
      const e = sketchElement(other, entity.id);
      if (!e) continue;
      const points = sketchElementPoints(e).map(([u, v]) => {
        const w = rotateVector(at.orientation, [u, v, 0]);
        const q = toUv(w[0] + at.origin[0], w[1] + at.origin[1], w[2] + at.origin[2]);
        grow(q[0], q[1]);
        return q;
      });
      lines.push({ sketchId: other.id, element: entity.id, points });
    }
  }
  return { shadows, lines, bounds: box };
}
