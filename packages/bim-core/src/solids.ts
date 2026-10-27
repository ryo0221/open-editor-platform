import type { BimContext, BimRoofFace, BimShape } from './derive';
import { layersThickness } from './derive';
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
 */
export function bimWallOpeningLoop(
  ctx: BimContext,
  wall: BimWall,
  alongMm: number,
  widthMm: number,
): BimLoop {
  const a = bimWallAxis(ctx, wall);
  const m = 10;
  if (!a.arc) {
    const n = left(a.x);
    const p = (t: number, off: number): Vec2 => [
      a.s[0] + a.x[0] * t + n[0] * off,
      a.s[1] + a.x[1] * t + n[1] * off,
    ];
    return [
      p(alongMm, a.rightOff - m),
      p(alongMm + widthMm, a.rightOff - m),
      p(alongMm + widthMm, a.leftOff + m),
      p(alongMm, a.leftOff + m),
    ];
  }
  const sign = Math.sign(a.arc.sweep);
  const radii = [a.arc.radius - sign * a.leftOff, a.arc.radius - sign * a.rightOff];
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

/** Height of a profile across its depth (the beam's vertical extent). */
export const profileHeight = (p: BimProfile) => (p.shape === 'circle' ? p.diameterMm : p.depthMm);

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
