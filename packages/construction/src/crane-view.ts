/**
 * CS3b (docs/cad/construction-site.md): cranes in the view, as simple parametric shapes (CS-U4):
 * a tower crane's mast, jib and counter-jib with its counterweight, the trolley's rope and hook;
 * a mobile crane's carrier, boom, rope and hook. Each is drawn at a crane state (slew, radius,
 * hook height), so a lift can be played back.
 */
import {
  carrierWidth,
  counterJibShare,
  hookTop,
  jibDepth,
  mastWidth,
  type Crane,
  type CraneState,
  type Point3,
} from '@editor-platform/construction-core';
import type { ViewMesh, ViewSolid } from '@editor-platform/geometry-view';
import { sitePickPrefix } from './site-view';

type Bounds = [[number, number, number], [number, number, number]];

export const siteCraneId = (id: string) => `${sitePickPrefix}crane:${id}`;

const craneYellow = '#facc15';
const craneDark = '#334155';
const ropeColor = '#111827';
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * A box from `a` to `b` (its axis) with a square section `w` wide, turned about its axis so one
 * side stays level (or faces +x for an upright box).
 */
export function beamBox(
  a: Point3,
  b: Point3,
  w: number,
  h = w,
): { positions: number[]; indices: number[] } {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
  const u = d.map((x) => x / len);
  // A side direction level with the ground (or +x when the axis is upright).
  let s = [-u[1]!, u[0]!, 0];
  const sl = Math.hypot(s[0]!, s[1]!);
  s = sl > 1e-9 ? s.map((x) => x / sl) : [1, 0, 0];
  const t = [
    u[1]! * s[2]! - u[2]! * s[1]!,
    u[2]! * s[0]! - u[0]! * s[2]!,
    u[0]! * s[1]! - u[1]! * s[0]!,
  ];
  const corners: number[] = [];
  for (const p of [a, b])
    for (const [i, j] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const)
      corners.push(
        p[0] + (s[0]! * i * w) / 2 + (t[0]! * j * h) / 2,
        p[1] + (s[1]! * i * w) / 2 + (t[1]! * j * h) / 2,
        p[2] + (s[2]! * i * w) / 2 + (t[2]! * j * h) / 2,
      );
  // Each face its own four corners, so each keeps a flat normal.
  const faces = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  for (const f of faces) {
    const first = positions.length / 3;
    for (const k of f) positions.push(corners[k * 3]!, corners[k * 3 + 1]!, corners[k * 3 + 2]!);
    // Outward: the corner order above winds outward when (s, t, u) is right-handed.
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
  return { positions, indices };
}

function mesh(parts: { positions: number[]; indices: number[] }[]): ViewMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const p of parts) {
    const first = positions.length / 3;
    positions.push(...p.positions);
    indices.push(...p.indices.map((i) => i + first));
  }
  const normals = new Array<number>(positions.length).fill(0);
  for (let k = 0; k < indices.length; k += 3) {
    const [a, b, c] = [indices[k]! * 3, indices[k + 1]! * 3, indices[k + 2]! * 3];
    const e1 = [0, 1, 2].map((i) => positions[b + i]! - positions[a + i]!);
    const e2 = [0, 1, 2].map((i) => positions[c + i]! - positions[a + i]!);
    const n = [
      e1[1]! * e2[2]! - e1[2]! * e2[1]!,
      e1[2]! * e2[0]! - e1[0]! * e2[2]!,
      e1[0]! * e2[1]! - e1[1]! * e2[0]!,
    ];
    const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    for (const v of [a, b, c]) for (let i = 0; i < 3; i++) normals[v + i] = n[i]! / l;
  }
  return {
    origin: [0, 0, 0],
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}

function bounds(m: ViewMesh[]): Bounds {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const x of m)
    for (let k = 0; k < x.positions.length; k += 3)
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i]!, x.positions[k + i]!);
        hi[i] = Math.max(hi[i]!, x.positions[k + i]!);
      }
  return [lo, hi];
}

/** A crane at a state (its default: slewed to +y at mid reach, hook up), as one view solid. */
export function craneSolid(
  crane: Crane,
  baseZ: number,
  state: CraneState | undefined,
  selected: boolean,
): ViewSolid {
  const [bx, by] = crane.base;
  const reach = crane.loadChart[crane.loadChart.length - 1]?.radius ?? crane.jibLength;
  const s: CraneState = state ?? {
    slew: Math.PI / 2,
    radius: (crane.minRadius + reach) / 2,
    hook: [
      bx,
      by + (crane.minRadius + reach) / 2,
      hookTop(crane, baseZ, (crane.minRadius + reach) / 2),
    ],
  };
  const dir = [Math.cos(s.slew), Math.sin(s.slew)];
  const steel: { positions: number[]; indices: number[] }[] = [];
  const dark: { positions: number[]; indices: number[] }[] = [];
  let tip: Point3;
  if (crane.kind === 'tower') {
    const z = baseZ + crane.height;
    steel.push(beamBox([bx, by, baseZ], [bx, by, z], mastWidth));
    const tail = crane.jibLength * counterJibShare;
    steel.push(
      beamBox(
        [bx - dir[0]! * tail, by - dir[1]! * tail, z + jibDepth / 2],
        [bx + dir[0]! * crane.jibLength, by + dir[1]! * crane.jibLength, z + jibDepth / 2],
        jibDepth,
      ),
    );
    // Counterweight at the counter-jib's end, the cab at the top of the mast.
    dark.push(
      beamBox(
        [bx - dir[0]! * tail * 0.9, by - dir[1]! * tail * 0.9, z - 1500],
        [bx - dir[0]! * tail * 0.7, by - dir[1]! * tail * 0.7, z - 1500],
        2400,
        3000,
      ),
    );
    tip = [s.hook[0], s.hook[1], z];
  } else {
    const pivotZ = baseZ + crane.height;
    dark.push(beamBox([bx, by, baseZ], [bx, by, pivotZ], carrierWidth));
    const rise = Math.sqrt(Math.max(0, crane.jibLength ** 2 - s.radius ** 2));
    tip = [bx + dir[0]! * s.radius, by + dir[1]! * s.radius, pivotZ + rise];
    steel.push(beamBox([bx, by, pivotZ], tip, jibDepth));
  }
  // The rope from the trolley (or the boom tip) to the hook, and the hook block.
  const rope = beamBox(tip, s.hook, 60);
  const hook = beamBox(
    [s.hook[0], s.hook[1], s.hook[2] + 900],
    [s.hook[0], s.hook[1], s.hook[2]],
    600,
  );
  const parts = [
    { mesh: mesh(steel), color: craneYellow, opacity: 1, sheet: false },
    { mesh: mesh([...dark, hook]), color: craneDark, opacity: 1, sheet: false },
    { mesh: mesh([rope]), color: ropeColor, opacity: 1, sheet: false },
  ];
  return {
    meshes: parts,
    bounds: bounds(parts.map((p) => p.mesh)),
    instances: [{ path: [siteCraneId(crane.id)], matrix: identity, selected }],
  };
}
