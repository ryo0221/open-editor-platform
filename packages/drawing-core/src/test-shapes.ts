import type { DrawingMeshBody } from './project';

// Meshes for the projection tests (not exported by the package).

/** A box [0,a]×[0,b]×[0,c] with outward triangles, 6 faces, and its 12 edges. */
export function box(
  a: number,
  b: number,
  c: number,
  at: [number, number, number] = [0, 0, 0],
): DrawingMeshBody {
  const v = (x: number, y: number, z: number) => [x * a + at[0], y * b + at[1], z * c + at[2]];
  const quads = [
    [
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [1, 0, 0],
    ], // z=0, normal -z
    [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ], // z=1
    [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ], // y=0, -y
    [
      [0, 1, 0],
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
    ], // y=1
    [
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
    ], // x=0
    [
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
      [1, 0, 1],
    ], // x=1
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  const faces: number[] = [];
  quads.forEach((q, f) => {
    const base = positions.length / 3;
    for (const p of q) positions.push(...v(p[0]!, p[1]!, p[2]!));
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    faces.push(f, f);
  });
  const corners = [0, 1].flatMap((x) => [0, 1].flatMap((y) => [0, 1].map((z) => [x, y, z])));
  const edges: DrawingMeshBody['edges'] = [];
  for (let i = 0; i < 8; i++)
    for (let j = i + 1; j < 8; j++) {
      const d = corners[i]!.map((k, n) => Math.abs(k - corners[j]![n]!));
      if (d.reduce((s, k) => s + k, 0) === 1)
        edges.push({
          index: edges.length,
          points: [
            ...v(...(corners[i] as [number, number, number])),
            ...v(...(corners[j] as [number, number, number])),
          ],
        });
    }
  return { path: [], bodyId: 'box', positions, indices, faces, edges };
}

/** A cylinder of radius r along z from 0 to h, n sides, with its two circles as edges. */
export function cylinder(r: number, h: number, n = 48): DrawingMeshBody {
  const positions: number[] = [];
  const indices: number[] = [];
  const faces: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    positions.push(r * Math.cos(t), r * Math.sin(t), 0, r * Math.cos(t), r * Math.sin(t), h);
  }
  for (let i = 0; i < n; i++) {
    const a = 2 * i;
    const b = 2 * ((i + 1) % n);
    indices.push(a, b, b + 1, a, b + 1, a + 1);
    faces.push(0, 0);
  }
  const circle = (z: number) => {
    const pts: number[] = [];
    for (let i = 0; i <= n; i++) {
      const t = (2 * Math.PI * i) / n;
      pts.push(r * Math.cos(t), r * Math.sin(t), z);
    }
    return pts;
  };
  return {
    path: ['c-1'],
    bodyId: 'cyl',
    positions,
    indices,
    faces,
    edges: [
      { index: 0, points: circle(0) },
      { index: 1, points: circle(h) },
    ],
  };
}
