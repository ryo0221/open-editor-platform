import type { TriangleSurface } from './voxelize';

/** A closed sphere (subdivided icosahedron, triangles wound outward), for tests (VS2). */
export function icosphere(
  center: [number, number, number],
  radius: number,
  subdivisions = 3,
): TriangleSurface {
  const t = (1 + Math.sqrt(5)) / 2;
  let points: number[][] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ];
  let faces: number[][] = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  const norm = (p: number[]) => {
    const l = Math.hypot(p[0]!, p[1]!, p[2]!);
    return p.map((v) => v / l);
  };
  points = points.map(norm);
  for (let s = 0; s < subdivisions; s++) {
    const mid = new Map<string, number>();
    const at = (a: number, b: number) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let m = mid.get(key);
      if (m === undefined) {
        m = points.length;
        points.push(norm(points[a]!.map((v, i) => (v + points[b]![i]!) / 2)));
        mid.set(key, m);
      }
      return m;
    };
    const next: number[][] = [];
    for (const [a, b, c] of faces) {
      const ab = at(a!, b!),
        bc = at(b!, c!),
        ca = at(c!, a!);
      next.push([a!, ab, ca], [b!, bc, ab], [c!, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  const positions = new Float64Array(points.length * 3);
  points.forEach((p, i) => {
    positions[3 * i] = center[0] + radius * p[0]!;
    positions[3 * i + 1] = center[1] + radius * p[1]!;
    positions[3 * i + 2] = center[2] + radius * p[2]!;
  });
  return { positions, triangles: Uint32Array.from(faces.flat()) };
}

/** A closed box from `min` to `max` (12 triangles wound outward). */
export function boxSurface(
  min: [number, number, number],
  max: [number, number, number],
): TriangleSurface {
  const positions = new Float64Array(24);
  for (let i = 0; i < 8; i++) {
    positions[3 * i] = i & 1 ? max[0] : min[0];
    positions[3 * i + 1] = i & 2 ? max[1] : min[1];
    positions[3 * i + 2] = i & 4 ? max[2] : min[2];
  }
  const quads = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  const triangles: number[] = [];
  for (const [a, b, c, d] of quads) triangles.push(a!, b!, c!, a!, c!, d!);
  return { positions, triangles: Uint32Array.from(triangles) };
}

/** The Ahmed body's sizes (mm; Ahmed, Ramm and Faltin 1984). */
export const ahmedSizes = Object.freeze({
  length: 1044,
  width: 389,
  height: 288,
  frontRadius: 100,
  slantLength: 222,
  clearance: 50,
});

/**
 * F96 (VS3): the Ahmed body with its rear slant at `slantDeg`, in the vehicle frame (nose toward
 * +x at x = 1044, tail at x = 0, y across, z up from the ground at the clearance of 50 mm). The
 * four front edges are rounded (R 100; two crossing cylinders, so every section along x is a
 * rectangle); the long edges are sharp. The four stilts are left out: the body is held at its
 * clearance. Closed, wound outward.
 */
export function ahmedBody(slantDeg: number, frontSteps = 12): TriangleSurface {
  const {
    length: L,
    width: W,
    height: H,
    frontRadius: R,
    slantLength: S,
    clearance: c,
  } = ahmedSizes;
  const phi = (slantDeg * Math.PI) / 180;
  const sx = S * Math.cos(phi);
  const zTop = c + H;
  const top = (x: number) => (x < sx ? zTop - (sx - x) * Math.tan(phi) : zTop);
  // Sections from the tail to the nose: [x, half width, z low, z high].
  const rows: [number, number, number, number][] = [];
  if (slantDeg > 0) for (const f of [0, 0.5]) rows.push([f * sx, W / 2, c, top(f * sx)]);
  else rows.push([0, W / 2, c, zTop]);
  rows.push([Math.max(sx, 1), W / 2, c, zTop]);
  for (let k = 0; k <= frontSteps; k++) {
    const t = R * (1 - Math.sin((k / frontSteps) * (Math.PI / 2)));
    const rho = Math.sqrt(Math.max(0, R * R - (R - t) ** 2));
    rows.push([L - t, W / 2 - R + rho, c + R - rho, zTop - R + rho]);
  }
  const positions: number[] = [];
  for (const [x, y, z0, z1] of rows) positions.push(x, -y, z0, x, y, z0, x, y, z1, x, -y, z1);
  const triangles: number[] = [];
  for (let i = 0; i + 1 < rows.length; i++)
    for (let k = 0; k < 4; k++) {
      const a = 4 * i + k;
      const b = 4 * i + ((k + 1) % 4);
      triangles.push(a, b, b + 4, a, b + 4, a + 4);
    }
  const n = 4 * (rows.length - 1);
  triangles.push(0, 3, 2, 0, 2, 1, n, n + 1, n + 2, n, n + 2, n + 3);
  return {
    positions: Float64Array.from(positions),
    triangles: Uint32Array.from(triangles),
  };
}
