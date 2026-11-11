import type { BimContext, BimRoofFace, BimShape } from './derive';
import { layersThickness, loopExtreme } from './derive';
import { arcOf, arcPoint, left, sub, unit } from './geometry';
import type { BimLoop, BimProfile, BimWall, Vec2, Vec3 } from './model';

/**
 * Where the solids of elements lie, shared by the kernel's op graph (`bimGeometry`) and the IFC
 * export, so that both describe the same solid.
 */

/** A wall's axis: its ends, its arc, its length and its faces' offsets to the left of travel. */
export function bimWallAxis(ctx: BimContext, wall: BimWall) {
  const s = ctx.point(wall.start, '');
  const e = ctx.point(wall.end, '');
  const t = layersThickness(ctx.types.get(wall.typeId)!);
  const [leftOff, rightOff] =
    wall.location === 'center' ? [t / 2, -t / 2] : wall.location === 'left' ? [0, -t] : [t, 0];
  const arc = wall.bulge ? arcOf(s, e, wall.bulge) : undefined;
  const length = arc ? arc.radius * Math.abs(arc.sweep) : Math.hypot(...sub(e, s));
  /** Point and tangent on the axis at `along` mm from the start. */
  const at = (along: number): [Vec2, Vec2] => {
    if (!arc) {
      const u = unit(sub(e, s));
      return [[s[0] + u[0] * along, s[1] + u[1] * along], u];
    }
    const p = arcPoint(arc, along / length);
    const r = unit(sub(p, arc.center));
    return [p, Math.sign(arc.sweep) > 0 ? left(r) : [r[1], -r[0]]];
  };
  return { s, e, arc, length, leftOff, rightOff, at, x: unit(sub(e, s)) };
}

/**
 * The plan region an opening of a wall cuts, reaching 10 mm past both faces; on an arc wall
 * at most half the inner face's radius inwards, so the region never reaches the centre.
 * FU3a: a leaning wall's at `rise` mm above its base, where its faces have moved to the right
 * by rise·tan(lean) (an arc's radially, at the same angles) and stand thickness ÷ cos(lean)
 * apart in plan. With `band`, the region of a door's or window's panel instead: `band` mm
 * either side of the wall's middle (square to the face), not past the faces.
 */
export function bimWallOpeningLoop(
  ctx: BimContext,
  wall: BimWall,
  alongMm: number,
  widthMm: number,
  rise = 0,
  band?: number,
): BimLoop {
  const a = bimWallAxis(ctx, wall);
  const lean = wall.lean ?? 0;
  const k = 1 / Math.cos(lean);
  const shift = rise * Math.tan(lean);
  const mid = (a.leftOff + a.rightOff) / 2;
  const leftOff =
    (band === undefined ? a.leftOff : mid + Math.sign(a.leftOff - a.rightOff || 1) * band) * k;
  const rightOff =
    (band === undefined ? a.rightOff : mid - Math.sign(a.leftOff - a.rightOff || 1) * band) * k;
  const m = band === undefined ? 10 : 0;
  if (!a.arc) {
    const n = left(a.x);
    const p = (t: number, off: number): Vec2 => [
      a.s[0] + a.x[0] * t + n[0] * (off - shift),
      a.s[1] + a.x[1] * t + n[1] * (off - shift),
    ];
    return [
      p(alongMm, rightOff - m),
      p(alongMm + widthMm, rightOff - m),
      p(alongMm + widthMm, leftOff + m),
      p(alongMm, leftOff + m),
    ];
  }
  const sign = Math.sign(a.arc.sweep);
  const radius = a.arc.radius + sign * shift;
  const radii = [radius - sign * leftOff, radius - sign * rightOff];
  const rOut = Math.max(...radii) + m;
  const rIn = Math.min(...radii) - Math.min(m, Math.min(...radii) / 2);
  const a0 = a.arc.startAngle + (sign * alongMm) / a.arc.radius;
  const a1 = a.arc.startAngle + (sign * (alongMm + widthMm)) / a.arc.radius;
  const q = (r: number, ang: number): Vec2 => [
    a.arc!.center[0] + r * Math.cos(ang),
    a.arc!.center[1] + r * Math.sin(ang),
  ];
  const b = Math.tan((a1 - a0) / 4);
  const outer0 = q(rOut, a0);
  const outer1 = q(rOut, a1);
  return [
    [outer0[0], outer0[1], b],
    outer1,
    [...q(rIn, a1), -b] as [number, number, number],
    q(rIn, a0),
  ];
}

/**
 * FU3a: how high above a wall's base an opening's sill and head are, its sill and height being
 * measured along the face (FU-U4): × cos(lean).
 */
export function bimWallOpeningRise(wall: BimWall, sillMm: number, heightMm: number) {
  const c = Math.cos(wall.lean ?? 0);
  return [sillMm * c, (sillMm + heightMm) * c] as const;
}

/** A plane in world coordinates: a point and its unit normal. */
export interface BimPlane {
  p: Vec3;
  n: Vec3;
}

/** A roof plane's underside and top, normals pointing up. */
export function bimRoofPlanes(s: Extract<BimShape, { kind: 'roof' }>, f: BimRoofFace) {
  const n: Vec3 = [-f.slope * f.direction[0], -f.slope * f.direction[1], 1];
  const len = Math.hypot(...n);
  const under: BimPlane = {
    p: [f.origin[0], f.origin[1], s.zBase],
    n: n.map((c) => c / len) as Vec3,
  };
  const rise = s.thicknessMm * Math.sqrt(1 + f.slope * f.slope);
  const top: BimPlane = { p: [f.origin[0], f.origin[1], s.zBase + rise], n: under.n };
  return { under, top };
}

/**
 * TW5: a sloped slab's top and bottom planes (normals up), and how low and high its top runs
 * over the boundary (exact on arcs). The kernel and the IFC export both clip by them.
 */
export function bimSlabPlanes(s: Extract<BimShape, { kind: 'slab' }>) {
  const sl = s.slope!;
  const n: Vec3 = [-sl.grade * sl.direction[0], -sl.grade * sl.direction[1], 1];
  const len = Math.hypot(...n);
  const normal = n.map((c) => c / len) as Vec3;
  const top: BimPlane = { p: [sl.origin[0], sl.origin[1], s.zTop], n: normal };
  const bottom: BimPlane = { p: [sl.origin[0], sl.origin[1], s.zBottom], n: normal };
  const at = (d: Vec2) => {
    const q = loopExtreme(s.boundary, d);
    return (
      s.zTop +
      sl.grade * ((q[0] - sl.origin[0]) * sl.direction[0] + (q[1] - sl.origin[1]) * sl.direction[1])
    );
  };
  const a = at(sl.direction);
  const b = at([-sl.direction[0], -sl.direction[1]]);
  return { top, bottom, zLow: Math.min(a, b), zHigh: Math.max(a, b) };
}

/**
 * TW2: where a section runs along a straight element: from `origin` along `z` for `length`, its
 * width along `x` and its depth along `y` = z × x (unit vectors, x square to z). Columns, beams
 * and members; the kernel and the IFC export both place their sections by it.
 */
export interface BimSectionAxes {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
  length: number;
}
const norm3 = (v: Vec3): Vec3 | undefined => {
  const n = Math.hypot(...v);
  return n > 1e-12 ? [v[0] / n, v[1] / n, v[2] / n] : undefined;
};
const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
/** Axes along `axis` from `origin`, with x as near `x` as square to the axis allows. */
function sectionAxes(origin: Vec3, axis: Vec3, x: Vec3): BimSectionAxes {
  const length = Math.hypot(...axis);
  const z = norm3(axis)!;
  const d = z[0] * x[0] + z[1] * x[1] + z[2] * x[2];
  const xs = norm3([x[0] - d * z[0], x[1] - d * z[1], x[2] - d * z[2]])!;
  return { origin, x: xs, y: cross3(z, xs), z, length };
}
export function bimSectionAxes(
  s: Extract<BimShape, { kind: 'column' | 'beam' | 'member' }>,
): BimSectionAxes {
  switch (s.kind) {
    case 'column': {
      const top = s.topAt ?? s.at;
      return sectionAxes(
        [s.at[0], s.at[1], s.zBase],
        [top[0] - s.at[0], top[1] - s.at[1], s.zTop - s.zBase],
        [Math.cos(s.rotationRad), Math.sin(s.rotationRad), 0],
      );
    }
    case 'beam': {
      // The axis runs half the section's depth below the top heights at the ends.
      const half = profileHeight(s.profile) / 2;
      const rise = (s.zTopEnd ?? s.zTop) - s.zTop;
      const u = unit(sub(s.end, s.start));
      const n = left(u);
      return sectionAxes(
        [s.start[0], s.start[1], s.zTop - half],
        [s.end[0] - s.start[0], s.end[1] - s.start[1], rise],
        [n[0], n[1], 0],
      );
    }
    case 'member': {
      const axis: Vec3 = [s.end[0] - s.start[0], s.end[1] - s.start[1], s.end[2] - s.start[2]];
      const z = norm3(axis)!;
      // Width level and square to the axis (along +x for a vertical member), depth upward,
      // then turned by `rotationRad` about the axis.
      const level = norm3(cross3([0, 0, 1], z)) ?? [1, 0, 0];
      const up = cross3(z, level);
      const [c, si] = [Math.cos(s.rotationRad), Math.sin(s.rotationRad)];
      return sectionAxes(s.start, axis, [
        c * level[0] + si * up[0],
        c * level[1] + si * up[1],
        c * level[2] + si * up[2],
      ]);
    }
  }
}

/** Height of a profile across its depth (the beam's vertical extent). */
export const profileHeight = (p: BimProfile) => ('diameterMm' in p ? p.diameterMm : p.depthMm);

/**
 * A profile as loops about the centre of its bounding box, x across its width and y across its
 * depth, as IFC4's parameterized profiles place them (sharp corners: no fillet radii).
 */
export function bimProfileLoops(p: BimProfile): { outer: BimLoop; holes: BimLoop[] } {
  const rect = (w: number, d: number, cx = 0, cy = 0): BimLoop => [
    [cx - w / 2, cy - d / 2],
    [cx + w / 2, cy - d / 2],
    [cx + w / 2, cy + d / 2],
    [cx - w / 2, cy + d / 2],
  ];
  switch (p.shape) {
    case 'rect':
      return { outer: rect(p.widthMm, p.depthMm), holes: [] };
    case 'circle': {
      const r = p.diameterMm / 2;
      return {
        outer: [
          [r, 0, 1],
          [-r, 0, 1],
        ],
        holes: [],
      };
    }
    case 'pipe': {
      const [r, ri] = [p.diameterMm / 2, p.diameterMm / 2 - p.wallMm];
      return {
        outer: [
          [r, 0, 1],
          [-r, 0, 1],
        ],
        holes: [
          [
            [ri, 0, 1],
            [-ri, 0, 1],
          ],
        ],
      };
    }
    case 'box':
      return {
        outer: rect(p.widthMm, p.depthMm),
        holes: [rect(p.widthMm - 2 * p.wallMm, p.depthMm - 2 * p.wallMm)],
      };
    case 'h': {
      const [w, d, t, f] = [p.widthMm / 2, p.depthMm / 2, p.webMm / 2, p.flangeMm];
      return {
        outer: [
          [-w, -d],
          [w, -d],
          [w, -d + f],
          [t, -d + f],
          [t, d - f],
          [w, d - f],
          [w, d],
          [-w, d],
          [-w, d - f],
          [-t, d - f],
          [-t, -d + f],
          [-w, -d + f],
        ],
        holes: [],
      };
    }
    case 'channel': {
      // The web on the -x side, the flanges reaching to +x.
      const [w, d, t, f] = [p.widthMm / 2, p.depthMm / 2, p.webMm, p.flangeMm];
      return {
        outer: [
          [-w, -d],
          [w, -d],
          [w, -d + f],
          [-w + t, -d + f],
          [-w + t, d - f],
          [w, d - f],
          [w, d],
          [-w, d],
        ],
        holes: [],
      };
    }
    case 'l': {
      // The legs along -x and -y.
      const [w, d, t] = [p.widthMm / 2, p.depthMm / 2, p.thicknessMm];
      return {
        outer: [
          [-w, -d],
          [w, -d],
          [w, -d + t],
          [-w + t, -d + t],
          [-w + t, d],
          [-w, d],
        ],
        holes: [],
      };
    }
  }
}
