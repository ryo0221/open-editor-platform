import { boxEdges } from '@editor-platform/geometry-fem';
import type { SurfaceMeshInput } from './surface';

/**
 * A box's boundary as the mesher's input, the stand-in for the kernel's triangulation until R3c-2:
 * each face a grid of `divisions` cells split in two, tagged in `boxFaces` order (x0, x1, y0, y1,
 * z0, z1), and the 12 edges in `boxEdges` order. Shared points are shared indices.
 */
export function boxSurface(
  size: readonly [number, number, number],
  divisions: readonly [number, number, number],
): SurfaceMeshInput {
  const points: number[] = [];
  const index = new Map<string, number>();
  // Points are shared by integer grid position; the far end of each axis is exactly `size`.
  const at = (axis: number, i: number) =>
    i === divisions[axis] ? size[axis]! : (size[axis]! * i) / divisions[axis]!;
  const point = (g: readonly number[]) => {
    const k = g.join(',');
    let i = index.get(k);
    if (i === undefined) {
      i = points.length / 3;
      index.set(k, i);
      points.push(at(0, g[0]!), at(1, g[1]!), at(2, g[2]!));
    }
    return i;
  };
  const triangles: number[] = [];
  const faces: number[] = [];
  for (let f = 0; f < 6; f++) {
    const axis = f >> 1,
      side = f & 1;
    const [u, v] = [0, 1, 2].filter((a) => a !== axis) as [number, number];
    const corner = (i: number, j: number) => {
      const g = [0, 0, 0];
      g[axis] = side ? divisions[axis]! : 0;
      g[u] = i;
      g[v] = j;
      return point(g);
    };
    // (u, v, axis) is right-handed for axis x and z, left-handed for y.
    const outward = (side === 1) !== (axis === 1);
    for (let i = 0; i < divisions[u]!; i++)
      for (let j = 0; j < divisions[v]!; j++) {
        const a = corner(i, j),
          b = corner(i + 1, j),
          c = corner(i + 1, j + 1),
          d = corner(i, j + 1);
        if (outward) triangles.push(a, b, c, a, c, d);
        else triangles.push(a, c, b, a, d, c);
        faces.push(f, f);
      }
  }
  // Each box edge: the line where its two faces meet, walked along the remaining axis.
  const offsets = [0];
  const chain: number[] = [];
  for (const [f1, f2] of boxEdges) {
    const g = [0, 0, 0];
    for (const f of [f1, f2]) g[f >> 1] = f & 1 ? divisions[f >> 1]! : 0;
    const axis = [0, 1, 2].find((a) => a !== f1 >> 1 && a !== f2 >> 1)!;
    for (let i = 0; i <= divisions[axis]!; i++) {
      g[axis] = i;
      chain.push(point(g));
    }
    offsets.push(chain.length);
  }
  return {
    points: new Float64Array(points),
    triangles: new Uint32Array(triangles),
    faces: new Uint32Array(faces),
    shapeFaces: 6,
    shapeEdges: boxEdges.length,
    edges: { offsets: new Uint32Array(offsets), nodes: new Uint32Array(chain) },
  };
}
