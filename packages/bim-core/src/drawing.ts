import { geometryLimits, type GeometryVec3 } from '@editor-platform/geometry-core';
import { BimContext, type BimDerived, deriveBim } from './derive';
import {
  add,
  cross,
  distance,
  dot,
  left,
  loopArea,
  sampleLoop,
  scale,
  sub,
  unit,
} from './geometry';
import type { BimDocument, BimDrawingScale, BimType, BimView, Vec2, Vec3 } from './model';
import type { BimPlacement } from './ops';
import { bimRoofPlanes, bimWallAxis } from './solids';

/**
 * Plans and sections (docs/cad/r2c-architecture.md, 平面図と断面図; R2c-U7). A drawing is
 * derived data, never saved. This module is pure: the frame a view is cut and seen in, and the
 * symbols and annotations drawn by rule rather than from the 3D shapes (door swings, window
 * marks, grid lines and bubbles, level marks, grid dimensions, space names and areas). The
 * kernel's cut and projection are added by the bim package (`drawBim`), and `bimDrawingSvg`
 * writes the result.
 */

/** Paper sizes in mm; a drawing multiplies them by its scale (1:50, 1:100, 1:200). */
export const bimDrawingPaper = Object.freeze({
  cutStrokeMm: 0.5,
  seenStrokeMm: 0.18,
  symbolStrokeMm: 0.25,
  thinStrokeMm: 0.13,
  textMm: 2.5,
  bubbleRadiusMm: 4,
  /** How far grid lines run past their ends, and dimensions sit outside them. */
  gridOverrunMm: 8,
});
export const bimDrawingLimits = Object.freeze({
  /** Lines, arcs and polygon edges of one drawing. */
  primitives: 200_000,
  svgBytes: 32 * 1024 * 1024,
});
/**
 * The fixed tessellation of what a drawing sees (R2c-U7): never the display's LOD, so changing
 * the view's level of detail or budget never changes a drawing.
 */
export const bimDrawingMesh = Object.freeze({ deflectionMm: 0.5, angularDeflectionRad: 0.1 });

/** A drawing's primitives, in the view's 2D coordinates (mm, y up). */
export type BimDrawingItem =
  /**
   * A cut: the closed loops of one element where the plane meets it, filled by its material, and
   * the chains that never close (a sheet's cut) drawn as heavy lines without a fill.
   */
  | { type: 'polygon'; loops: Vec2[][]; open?: Vec2[][]; cls: string; id: string }
  /** Many segments `x0 y0 x1 y1 …` of one class (what lies beyond the cut). */
  | { type: 'segments'; points: number[]; cls: string }
  | { type: 'line'; a: Vec2; b: Vec2; cls: string; id?: string }
  /** Counter-clockwise from `start` to `end` (rad). */
  | {
      type: 'arc';
      center: Vec2;
      radius: number;
      start: number;
      end: number;
      cls: string;
      id?: string;
    }
  | { type: 'circle'; center: Vec2; radius: number; cls: string }
  | {
      type: 'text';
      at: Vec2;
      text: string;
      anchor: 'start' | 'middle' | 'end';
      cls: string;
      id?: string;
    };

export interface BimDrawing {
  viewId: string;
  kind: BimView['kind'];
  name: string;
  scale: BimDrawingScale;
  items: BimDrawingItem[];
  /** Elements that could not be derived or built: listed on the drawing, never left out silently. */
  failed: { id: string; code: string }[];
}

/**
 * Where a view cuts and looks. `keep` are the half-spaces of what it sees (the cut plane, then
 * the depth); `direction` points into the scene and `up` is the drawing's y. `toView` maps a
 * model point to the drawing, as the kernel's projection does (x along `up` × −`direction`).
 */
export interface BimViewFrame {
  cut: { origin: GeometryVec3; normal: GeometryVec3 };
  keep: { origin: GeometryVec3; normal: GeometryVec3; keep: 'above' | 'below' }[];
  direction: GeometryVec3;
  up: GeometryVec3;
  toView(p: Vec3): Vec2;
  /** Plan: the cut's elevation. */
  cutZ?: number;
}

/**
 * A plane the kernel can take: its origin moved along the plane into the coordinate limit. A
 * plane that misses every point the limit allows is moved to the farthest such point, which
 * leaves every shape within the limit on the same side. A drawing clips a placed solid in its
 * own frame (`bimLocalPlane`), where its shape is within the limit, so this is exact there too.
 */
export function bimPlaneInRange<T extends { origin: GeometryVec3; normal: GeometryVec3 }>(
  plane: T,
): T {
  const limit = geometryLimits.coordinateMm;
  if (plane.origin.every((c) => Math.abs(c) <= limit)) return plane;
  const n = plane.normal;
  const sum = Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]);
  const d = Math.max(-limit * sum, Math.min(limit * sum, dot3(plane.origin, n)));
  // Each coordinate is sign(nᵢ)·d/Σ|nᵢ|: on the plane, and at most the limit.
  return { ...plane, origin: n.map((c) => (Math.sign(c) * d) / sum || 0) as GeometryVec3 };
}
const dot3 = (a: GeometryVec3, b: GeometryVec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A plane in a placed solid's own frame: Rᵀ(o − t) and Rᵀn. */
export function bimLocalPlane<T extends { origin: GeometryVec3; normal: GeometryVec3 }>(
  plane: T,
  placement: BimPlacement,
): T {
  const r = placement.rotation;
  const back = (v: GeometryVec3): GeometryVec3 => [
    r[0]! * v[0] + r[3]! * v[1] + r[6]! * v[2],
    r[1]! * v[0] + r[4]! * v[1] + r[7]! * v[2],
    r[2]! * v[0] + r[5]! * v[1] + r[8]! * v[2],
  ];
  const t = placement.translation;
  return {
    ...plane,
    origin: back([plane.origin[0] - t[0], plane.origin[1] - t[1], plane.origin[2] - t[2]]),
    normal: back(plane.normal),
  };
}

/** A point of a placed solid's frame in the model: R·p + t. */
export function bimPlacedPoint(p: GeometryVec3, placement: BimPlacement): GeometryVec3 {
  const r = placement.rotation;
  const t = placement.translation;
  return [
    r[0]! * p[0] + r[1]! * p[1] + r[2]! * p[2] + t[0],
    r[3]! * p[0] + r[4]! * p[1] + r[5]! * p[2] + t[1],
    r[6]! * p[0] + r[7]! * p[1] + r[8]! * p[2] + t[2],
  ];
}

/**
 * Where a view cuts and looks, in the model. Its planes may lie past the kernel's coordinate
 * limit: the drawing moves each into range (`bimPlaneInRange`) in the frame it clips in.
 */
export function bimViewFrame(doc: BimDocument, view: BimView): BimViewFrame {
  return viewFrame(doc, view);
}

function viewFrame(doc: BimDocument, view: BimView): BimViewFrame {
  if (view.kind === 'plan') {
    const level = doc.levels.find((l) => l.id === view.level)!;
    const z = level.elevationMm + view.cutHeightMm;
    return {
      cut: { origin: [0, 0, z], normal: [0, 0, 1] },
      keep: [
        { origin: [0, 0, z], normal: [0, 0, 1], keep: 'below' },
        { origin: [0, 0, z - view.depthMm], normal: [0, 0, 1], keep: 'above' },
      ],
      direction: [0, 0, -1],
      up: [0, 1, 0],
      toView: (p) => [p[0], p[1]],
      cutZ: z,
    };
  }
  const [a, b] = view.line;
  const u = unit(sub(b, a));
  const d = view.direction === 'left' ? left(u) : scale(left(u), -1);
  const d3: GeometryVec3 = [d[0], d[1], 0];
  // The kernel's x is up × −direction: along the line when looking left, against it otherwise.
  const x: Vec2 = [d[1], -d[0]];
  const far = add(a, scale(d, view.depthMm));
  return {
    cut: { origin: [a[0], a[1], 0], normal: d3 },
    keep: [
      { origin: [a[0], a[1], 0], normal: d3, keep: 'above' },
      { origin: [far[0], far[1], 0], normal: d3, keep: 'below' },
    ],
    direction: d3,
    up: [0, 0, 1],
    toView: (p) => [p[0] * x[0] + p[1] * x[1], p[2]],
  };
}

/** An axis-aligned box `[min, max]` in mm. */
export type BimBox = [Vec3, Vec3];

/**
 * A box that holds all of an element's solid, from its derived shape, or `undefined` when the
 * shape alone does not bound it (parts). It may be larger than the solid, never
 * smaller: a drawing leaves out only what lies wholly outside the part of space it keeps.
 */
export function bimElementBox(
  doc: BimDocument,
  derived: BimDerived,
  id: string,
): BimBox | undefined {
  const s = derived.shapes.get(id);
  if (!s) return undefined;
  // A profile lies within the sum of its sizes of its centre, whatever its shape and turn.
  const reach = (p: object) =>
    Object.values(p).reduce((r: number, v) => (typeof v === 'number' ? r + v : r), 0);
  switch (s.kind) {
    case 'wall':
      return box(loopBox(s.footprint), s.zBase, s.zTop);
    case 'slab':
      return box(loopBox(s.boundary), s.zBottom, s.zTop);
    case 'column': {
      const r = reach(s.profile);
      return box(grow([s.at, s.at], r), s.zBase, s.zTop);
    }
    case 'beam': {
      const r = reach(s.profile);
      return box(grow(pointsBox([s.start, s.end]), r), s.zTop - r, s.zTop + r);
    }
    case 'roof': {
      // Each plane is linear, so over the plan box its heights lie between those at the corners.
      const [lo, hi] = loopBox(s.boundary);
      let z0 = s.zBase;
      let z1 = s.zBase;
      for (const f of s.faces) {
        const rise = s.thicknessMm * Math.sqrt(1 + f.slope * f.slope);
        for (const x of [lo[0], hi[0]])
          for (const y of [lo[1], hi[1]]) {
            const z = s.zBase + f.slope * dot(sub([x, y], f.origin), f.direction);
            z0 = Math.min(z0, z);
            z1 = Math.max(z1, z + rise);
          }
      }
      return box([lo, hi], z0, z1);
    }
    case 'void': {
      // A door's or window's panel stands in its host wall, within its own sizes of it.
      const el = doc.elements.find((e) => e.id === id);
      const type = el && 'typeId' in el ? doc.types.find((t) => t.id === el.typeId) : undefined;
      const host = bimElementBox(doc, derived, s.hostId);
      if (!host || !type || (type.kind !== 'door' && type.kind !== 'window')) return undefined;
      const r = type.widthMm + type.heightMm;
      return [
        [host[0][0] - r, host[0][1] - r, host[0][2] - r],
        [host[1][0] + r, host[1][1] + r, host[1][2] + r],
      ];
    }
    default:
      return undefined;
  }
}

/**
 * Which side of a plane a box lies wholly on, by more than 1 mm (`above`: along the normal), or
 * `both` when it reaches within 1 mm of the plane or across it.
 */
export function bimBoxSide(
  plane: { origin: GeometryVec3; normal: GeometryVec3 },
  b: BimBox,
): 'above' | 'below' | 'both' {
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of [b[0][0], b[1][0]])
    for (const y of [b[0][1], b[1][1]])
      for (const z of [b[0][2], b[1][2]]) {
        const d =
          (x - plane.origin[0]) * plane.normal[0] +
          (y - plane.origin[1]) * plane.normal[1] +
          (z - plane.origin[2]) * plane.normal[2];
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
      }
  return lo > 1 ? 'above' : hi < -1 ? 'below' : 'both';
}

/** Whether a box lies wholly, by more than 1 mm, on the side a view's frame leaves out. */
export function bimOutsideFrame(frame: BimViewFrame, b: BimBox): boolean {
  return frame.keep.some((k) => bimBoxSide(k, b) === (k.keep === 'above' ? 'below' : 'above'));
}

const pointsBox = (ps: readonly (readonly number[])[]): [Vec2, Vec2] => [
  [Math.min(...ps.map((p) => p[0]!)), Math.min(...ps.map((p) => p[1]!))],
  [Math.max(...ps.map((p) => p[0]!)), Math.max(...ps.map((p) => p[1]!))],
];
const grow = ([lo, hi]: [Vec2, Vec2], r: number): [Vec2, Vec2] => [
  [lo[0] - r, lo[1] - r],
  [hi[0] + r, hi[1] + r],
];
/** A loop's plan box; an arc edge (|bulge| ≤ 1) stays within its sagitta of its chord. */
function loopBox(loop: readonly (readonly number[])[]) {
  let sag = 0;
  loop.forEach((v, i) => {
    const bulge = v[2];
    if (!bulge) return;
    const w = loop[(i + 1) % loop.length]!;
    sag = Math.max(sag, (Math.abs(bulge) * Math.hypot(w[0]! - v[0]!, w[1]! - v[1]!)) / 2);
  });
  return grow(pointsBox(loop), sag);
}
const box = ([lo, hi]: [Vec2, Vec2], z0: number, z1: number): BimBox => [
  [lo[0], lo[1], Math.min(z0, z1)],
  [hi[0], hi[1], Math.max(z0, z1)],
];

/** Which elements a view cuts and sees with the kernel; the rest are symbols or not drawn. */
export function bimDrawnByKernel(view: BimView, kind: BimDocument['elements'][number]['kind']) {
  if (kind === 'space' || kind === 'opening') return false;
  // A plan draws doors and windows by their symbols (R2c-U7), a section cuts them.
  if (view.kind === 'plan' && (kind === 'door' || kind === 'window')) return false;
  return true;
}

/** The fill class of an element's cut: its kind and its (first) material's category. */
export function bimCutClass(doc: BimDocument, id: string): string {
  const el = doc.elements.find((e) => e.id === id);
  if (!el) return 'cut';
  const type = 'typeId' in el ? doc.types.find((t) => t.id === el.typeId) : undefined;
  const materialId = type && materialOf(type);
  const category = doc.materials.find((m) => m.id === materialId)?.category;
  return `cut cut-${el.kind}${category ? ` m-${category}` : ''}`;
}
const materialOf = (t: BimType) =>
  'layers' in t ? t.layers[0]?.materialId : 'materialId' in t ? t.materialId : undefined;

const fmt = (n: number) => String(Math.round(n));

/**
 * The symbols and annotations of a view, by rule (R2c-U7): never from the 3D shapes, and never
 * drawn by hand in R2c.
 */
export function bimDrawingSymbols(
  doc: BimDocument,
  view: BimView,
  derived: BimDerived = deriveBim(doc),
): BimDrawingItem[] {
  const ctx = new BimContext(doc);
  const s = view.scale;
  const items: BimDrawingItem[] = [];
  const text = (
    at: Vec2,
    t: string,
    cls: string,
    anchor: 'start' | 'middle' | 'end' = 'middle',
    id?: string,
  ) => items.push({ type: 'text', at, text: t, anchor, cls, ...(id ? { id } : {}) });
  const bubble = (at: Vec2, label: string) => {
    items.push({
      type: 'circle',
      center: at,
      radius: bimDrawingPaper.bubbleRadiusMm * s,
      cls: 'grid-bubble',
    });
    text(at, label, 'grid-label');
  };
  const overrun = bimDrawingPaper.gridOverrunMm * s;

  if (view.kind === 'plan') {
    const frame = bimViewFrame(doc, view);
    const z = frame.cutZ!;
    // Doors and windows the cut passes through (in walls it cuts): they get symbols. A wall
    // over several storeys has its openings at their own heights.
    // A wall a roof clips (`clipBy`) ends under every roof plane: its top at a point is the
    // lowest of them there.
    const roofTop = (roofId: string, xy: Vec2) => {
      const roof = derived.shapes.get(roofId);
      if (roof?.kind !== 'roof') return Infinity;
      return Math.min(
        ...roof.faces.map((f) => {
          const { under } = bimRoofPlanes(roof, f);
          const [p, n] = [under.p, under.n];
          return p[2] - (n[0] * (xy[0] - p[0]) + n[1] * (xy[1] - p[1])) / n[2];
        }),
      );
    };
    const cutOpenings = new Set<string>();
    for (const w of doc.elements) {
      const sh = w.kind === 'wall' ? derived.shapes.get(w.id) : undefined;
      if (w.kind !== 'wall' || sh?.kind !== 'wall' || !(sh.zBase < z && sh.zTop > z)) continue;
      const axis = sh.clipBy ? bimWallAxis(ctx, w) : undefined;
      for (const o of sh.openings) {
        // The wall's top over the opening: its ends and middle, under the roof if clipped.
        const top = axis
          ? Math.max(
              ...[0, 0.5, 1].map((f) =>
                Math.min(sh.zTop, roofTop(sh.clipBy!, axis.at(o.alongMm + f * o.widthMm)[0])),
              ),
            )
          : sh.zTop;
        if (sh.zBase + o.sillMm < z && Math.min(sh.zBase + o.sillMm + o.heightMm, top) > z)
          cutOpenings.add(o.elementId);
      }
    }
    for (const e of doc.elements) {
      if ((e.kind !== 'door' && e.kind !== 'window') || !cutOpenings.has(e.id)) continue;
      const wall = ctx.elements.get(e.hostId);
      const type = ctx.types.get(e.typeId);
      if (wall?.kind !== 'wall' || (type?.kind !== 'door' && type?.kind !== 'window')) continue;
      const axis = bimWallAxis(ctx, wall);
      const w = type.widthMm;
      const [p0, t0] = axis.at(e.alongMm);
      const [p1, t1] = axis.at(e.alongMm + w);
      // Each end is offset along the wall's own normal there (an arc wall turns between them).
      const [n0, n1] = [left(t0), left(t1)];
      const face = (end: 0 | 1, off: number): Vec2 =>
        end ? add(p1, scale(n1, off)) : add(p0, scale(n0, off));
      const [mid, tm] = axis.at(e.alongMm + w / 2);
      const n = left(tm);
      if (e.kind === 'door') {
        // The leaf turns on the hinge side (`flipHand`) into the facing side (`flipFacing`).
        const outward = e.flipFacing ? -1 : 1;
        const off = outward > 0 ? axis.leftOff : axis.rightOff;
        const hinge = face(e.flipHand ? 1 : 0, off);
        const closed = face(e.flipHand ? 0 : 1, off);
        const along = unit(sub(closed, hinge));
        // The leaf spans jamb to jamb on this face: on an arc wall that is not the type's width.
        const leaf = distance(hinge, closed);
        const open = add(hinge, scale(e.flipHand ? n1 : n0, outward * leaf));
        items.push({ type: 'line', a: hinge, b: open, cls: 'door-leaf', id: e.id });
        // The swing from the closed position to the open one, counter-clockwise.
        const a0 = Math.atan2(along[1], along[0]);
        const a1 = Math.atan2(open[1] - hinge[1], open[0] - hinge[0]);
        const ccw = cross(along, sub(open, hinge)) > 0;
        items.push({
          type: 'arc',
          center: hinge,
          radius: leaf,
          start: ccw ? a0 : a1,
          end: ccw ? a1 : a0,
          cls: 'door-swing',
          id: e.id,
        });
        text(
          add(mid, scale(n, off + outward * (w + bimDrawingPaper.textMm * s))),
          type.name,
          'type-mark',
          awayFrom(scale(n, outward)),
          e.id,
        );
      } else {
        // Both faces and the glass on the axis: on an arc wall, arcs about its centre.
        for (const off of [axis.leftOff, axis.rightOff, (axis.leftOff + axis.rightOff) / 2]) {
          const [a, b] = [face(0, off), face(1, off)];
          const arc = axis.arc;
          if (!arc) {
            items.push({ type: 'line', a, b, cls: 'window-mark', id: e.id });
            continue;
          }
          const angle = (q: Vec2) => Math.atan2(q[1] - arc.center[1], q[0] - arc.center[0]);
          const [start, end] = arc.sweep > 0 ? [angle(a), angle(b)] : [angle(b), angle(a)];
          items.push({
            type: 'arc',
            center: arc.center,
            radius: distance(arc.center, a),
            start,
            end,
            cls: 'window-mark',
            id: e.id,
          });
        }
        const out = axis.leftOff + bimDrawingPaper.textMm * s * 1.5;
        text(add(mid, scale(n, out)), type.name, 'type-mark', awayFrom(n), e.id);
      }
    }
    // Spaces of this level: number, name and area.
    for (const e of doc.elements) {
      if (e.kind !== 'space' || e.base.level !== view.level) continue;
      const points = sampleLoop(e.boundary);
      const c = interiorPoint(points);
      // Unsigned: a boundary may run either way round.
      const area = Math.abs(loopArea(e.boundary)) / 1e6;
      const name = [e.number, e.name].filter(Boolean).join(' ');
      if (name) text(c, name, 'space-name', 'middle', e.id);
      text(
        [c[0], c[1] - bimDrawingPaper.textMm * s * 1.4],
        `${area.toFixed(2)} m²`,
        'space-area',
        'middle',
        e.id,
      );
    }
    // Grid axes: dashed lines past both ends, bubbles at both ends.
    for (const g of doc.grids) {
      const u = unit(sub(g.end, g.start));
      const a = sub(g.start, scale(u, overrun));
      const b = add(g.end, scale(u, overrun));
      items.push({ type: 'line', a, b, cls: 'grid' });
      bubble(sub(a, scale(u, bimDrawingPaper.bubbleRadiusMm * s)), g.label);
      bubble(add(b, scale(u, bimDrawingPaper.bubbleRadiusMm * s)), g.label);
    }
    // Dimensions between neighbouring parallel axes, outside their start ends.
    for (const { u, axes: family } of parallelFamilies(doc.grids)) {
      if (family.length < 2) continue;
      // The family's direction, as it was sorted: an axis drawn the other way round keeps it.
      const n = left(u);
      const offs = family.map((g) => dot(g.start, n));
      const along = Math.min(...family.map((g) => dot(g.start, u))) - overrun / 2;
      for (let i = 1; i < family.length; i++) {
        const a = add(scale(u, along), scale(n, offs[i - 1]!));
        const b = add(scale(u, along), scale(n, offs[i]!));
        items.push({ type: 'line', a, b, cls: 'dimension' });
        for (const p of [a, b])
          items.push({
            type: 'line',
            a: sub(p, scale(u, bimDrawingPaper.textMm * s * 0.4)),
            b: add(p, scale(u, bimDrawingPaper.textMm * s * 0.4)),
            cls: 'dimension',
          });
        const m = scale(add(a, b), 0.5);
        text(
          sub(m, scale(u, bimDrawingPaper.textMm * s * 0.6)),
          fmt(offs[i]! - offs[i - 1]!),
          'dimension-text',
        );
      }
    }
    return items;
  }

  // A section: level marks across the drawing, and the grid axes the line crosses.
  const frame = bimViewFrame(doc, view);
  const [la, lb] = view.line;
  const lu = unit(sub(lb, la));
  const crossings: { x: number; label: string }[] = [];
  for (const g of doc.grids) {
    const gu = sub(g.end, g.start);
    const denom = cross(lu, gu);
    if (Math.abs(denom) < 1e-9) continue;
    const t = cross(sub(g.start, la), gu) / denom;
    const u = cross(sub(g.start, la), lu) / denom;
    // Only an axis the line itself crosses, within both.
    if (u < -1e-9 || u > 1 + 1e-9 || t < -1e-9 || t > distance(la, lb) + 1e-9) continue;
    const p = add(la, scale(lu, t));
    crossings.push({ x: frame.toView([p[0], p[1], 0])[0], label: g.label });
  }
  const xa = frame.toView([la[0], la[1], 0])[0];
  const xb = frame.toView([lb[0], lb[1], 0])[0];
  const xs = [xa, xb, ...crossings.map((c) => c.x)];
  const x0 = Math.min(...xs) - overrun;
  const x1 = Math.max(...xs) + overrun;
  const levels = [...doc.levels].sort((a, b) => a.elevationMm - b.elevationMm);
  const zs = levels.map((l) => l.elevationMm);
  const z0 = Math.min(0, ...zs) - overrun;
  const z1 = Math.max(0, ...zs) + 3000 + overrun;
  for (const l of levels) {
    items.push({ type: 'line', a: [x0, l.elevationMm], b: [x1, l.elevationMm], cls: 'level' });
    const sign = l.elevationMm > 0 ? '+' : l.elevationMm < 0 ? '−' : '±';
    text(
      [x1 + bimDrawingPaper.textMm * s * 0.5, l.elevationMm + bimDrawingPaper.textMm * s * 0.3],
      `${l.name} ${sign}${fmt(Math.abs(l.elevationMm))}`,
      'level-label',
      'start',
      l.id,
    );
  }
  crossings.sort((a, b) => a.x - b.x || a.label.localeCompare(b.label));
  for (const c of crossings) {
    items.push({ type: 'line', a: [c.x, z0], b: [c.x, z1], cls: 'grid' });
    bubble([c.x, z1 + bimDrawingPaper.bubbleRadiusMm * s], c.label);
  }
  return items;
}

/** A label beside a wall reads away from it: from its start when it lies to the right. */
const awayFrom = (dir: Vec2): 'start' | 'middle' | 'end' =>
  dir[0] > 0.5 ? 'start' : dir[0] < -0.5 ? 'end' : 'middle';

/** Grid axes grouped by direction (either way), each sorted by its offset across. */
function parallelFamilies(grids: BimDocument['grids']) {
  const families: { u: Vec2; axes: BimDocument['grids'] }[] = [];
  for (const g of grids) {
    const u = unit(sub(g.end, g.start));
    const f = families.find((f) => Math.abs(cross(f.u, u)) < 1e-6);
    if (f) f.axes.push(g);
    else families.push({ u, axes: [g] });
  }
  return families.map((f) => {
    const n = left(f.u);
    return {
      u: f.u,
      axes: [...f.axes].sort(
        (a, b) => dot(a.start, n) - dot(b.start, n) || a.id.localeCompare(b.id),
      ),
    };
  });
}

/**
 * A point inside a polygon to label it by: its centroid when that is inside, else the middle of
 * the widest inside run of a horizontal line through it (a concave room's centroid can lie in
 * another room).
 */
function interiorPoint(points: Vec2[]): Vec2 {
  const c = centroid(points);
  if (inside(points, c)) return c;
  const ys = points.map((p) => p[1]);
  for (const y of [c[1], (Math.min(...ys) + Math.max(...ys)) / 2]) {
    const xs: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      const q = points[(i + 1) % points.length]!;
      if (p[1] > y !== q[1] > y) xs.push(p[0] + ((y - p[1]) / (q[1] - p[1])) * (q[0] - p[0]));
    }
    xs.sort((a, b) => a - b);
    let best: Vec2 | undefined;
    let width = 0;
    for (let i = 0; i + 1 < xs.length; i += 2)
      if (xs[i + 1]! - xs[i]! > width) {
        width = xs[i + 1]! - xs[i]!;
        best = [(xs[i]! + xs[i + 1]!) / 2, y];
      }
    if (best) return best;
  }
  return c;
}

/** Whether a point is inside a polygon (even-odd). */
function inside(points: Vec2[], p: Vec2) {
  let odd = false;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < a[0] + ((p[1] - a[1]) / (b[1] - a[1])) * (b[0] - a[0])
    )
      odd = !odd;
  }
  return odd;
}

function centroid(points: Vec2[]): Vec2 {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    const c = p[0] * q[1] - q[0] * p[1];
    a += c;
    cx += (p[0] + q[0]) * c;
    cy += (p[1] + q[1]) * c;
  }
  if (Math.abs(a) < 1e-9) return points[0] ?? [0, 0];
  return [cx / (3 * a), cy / (3 * a)];
}

/**
 * Joins a cut's edges (model-space polylines) into closed loops in the view. Ends meet within
 * 0.01 mm; an edge chain that never closes is kept apart as an open chain (never filled).
 */
export function bimCutLoops(
  edges: Float64Array[],
  toView: BimViewFrame['toView'],
): { loops: Vec2[][]; open: Vec2[][] } {
  const lines = edges
    .map((e) => {
      const pts: Vec2[] = [];
      for (let i = 0; i + 2 < e.length; i += 3) pts.push(toView([e[i]!, e[i + 1]!, e[i + 2]!]));
      return pts;
    })
    .filter((l) => l.length >= 2);
  // Ends by 0.01 mm cell; a match is searched in the neighbouring cells too, by distance, so
  // ends on either side of a cell boundary still meet.
  const tol = 0.01;
  const cell = (v: number) => Math.floor(v / tol);
  const ends = new Map<string, { line: number; first: boolean; p: Vec2 }[]>();
  lines.forEach((l, i) => {
    for (const first of [true, false]) {
      const p = first ? l[0]! : l[l.length - 1]!;
      const k = `${cell(p[0])},${cell(p[1])}`;
      ends.set(k, [...(ends.get(k) ?? []), { line: i, first, p }]);
    }
  });
  const used = new Set<number>();
  /** The nearest unused line end within the tolerance of `p`. */
  const nearest = (p: Vec2) => {
    let best: { line: number; first: boolean; d: number } | undefined;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const e of ends.get(`${cell(p[0]) + dx},${cell(p[1]) + dy}`) ?? []) {
          if (used.has(e.line)) continue;
          const d = distance(p, e.p);
          if (d < tol && (!best || d < best.d)) best = { line: e.line, first: e.first, d };
        }
    return best;
  };
  const loops: Vec2[][] = [];
  const open: Vec2[][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const chain = [...lines[i]!];
    for (;;) {
      const end = chain[chain.length - 1]!;
      if (chain.length > 2 && distance(end, chain[0]!) < tol) break;
      const next = nearest(end);
      if (!next) break;
      used.add(next.line);
      const l = lines[next.line]!;
      chain.push(...(next.first ? l : [...l].reverse()).slice(1));
    }
    if (chain.length > 2 && distance(chain[chain.length - 1]!, chain[0]!) < tol) {
      chain.pop();
      loops.push(chain);
    } else open.push(chain);
  }
  return { loops, open };
}

const n2 = (v: number) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

/**
 * Where a text item reaches: a conservative width (0.7 em a character) placed by its anchor, and
 * half a line up and down.
 */
function textBox(
  it: { at: Vec2; text: string; anchor: 'start' | 'middle' | 'end' },
  scale: number,
): [Vec2, Vec2] {
  const size = bimDrawingPaper.textMm * scale;
  const w = size * Math.max(1, it.text.length) * 0.7;
  const x0 =
    it.anchor === 'start' ? it.at[0] : it.anchor === 'end' ? it.at[0] - w : it.at[0] - w / 2;
  return [
    [x0, it.at[1] - size * 0.6],
    [x0 + w, it.at[1] + size * 0.6],
  ];
}

/** The drawing's extent in view coordinates (the SVG adds the list of what was not drawn). */
export function bimDrawingBounds(d: BimDrawing): [Vec2, Vec2] | undefined {
  const lo: Vec2 = [Infinity, Infinity];
  const hi: Vec2 = [-Infinity, -Infinity];
  const at = (p: Vec2, r = 0) => {
    lo[0] = Math.min(lo[0], p[0] - r);
    lo[1] = Math.min(lo[1], p[1] - r);
    hi[0] = Math.max(hi[0], p[0] + r);
    hi[1] = Math.max(hi[1], p[1] + r);
  };
  for (const it of d.items)
    switch (it.type) {
      case 'polygon':
        [...it.loops, ...(it.open ?? [])].forEach((l) => l.forEach((p) => at(p)));
        break;
      case 'segments':
        for (let i = 0; i + 1 < it.points.length; i += 2) at([it.points[i]!, it.points[i + 1]!]);
        break;
      case 'line':
        at(it.a);
        at(it.b);
        break;
      case 'circle':
        at(it.center, it.radius);
        break;
      case 'arc': {
        // Its ends, and each quarter point the counter-clockwise sweep passes.
        const on = (t: number): Vec2 => [
          it.center[0] + it.radius * Math.cos(t),
          it.center[1] + it.radius * Math.sin(t),
        ];
        let sweep = it.end - it.start;
        while (sweep < 0) sweep += 2 * Math.PI;
        at(on(it.start));
        at(on(it.start + sweep));
        for (let k = Math.ceil(it.start / (Math.PI / 2)); k * (Math.PI / 2) < it.start + sweep; k++)
          at(on(k * (Math.PI / 2)));
        break;
      }
      case 'text': {
        const [a, b] = textBox(it, d.scale);
        at(a);
        at(b);
        break;
      }
    }
  return lo[0] === Infinity ? undefined : [lo, hi];
}

/** How many lines, arcs and polygon edges a drawing has (its limit is `bimDrawingLimits`). */
export function bimDrawingPrimitives(d: BimDrawing) {
  let n = 0;
  for (const it of d.items)
    n +=
      it.type === 'polygon'
        ? [...it.loops, ...(it.open ?? [])].reduce((s, l) => s + l.length, 0)
        : it.type === 'segments'
          ? it.points.length / 4
          : 1;
  return n;
}

const escape = (t: string) =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The drawing as SVG: model millimetres, y up (flipped once on the root group), line weights and
 * text sizes from the scale, classes for every kind of line and fill. The same drawing always
 * gives the same bytes.
 */
export function bimDrawingSvg(d: BimDrawing): string {
  const s = d.scale;
  const p = bimDrawingPaper;
  const b = bimDrawingBounds(d) ?? [
    [0, 0],
    [1000, 1000],
  ];
  const margin = 10 * s;
  // What was not drawn: a line each, below the drawing, inside the page.
  const failures = d.failed.length
    ? ['Not drawn:', ...d.failed.map((f) => `${f.id} (${f.code})`)].map((text, i) => ({
        at: [b[0][0], b[0][1] - margin / 2 - i * p.textMm * s * 1.4] as Vec2,
        text,
        anchor: 'start' as const,
      }))
    : [];
  for (const f of failures) {
    const [lo, hi] = textBox(f, s);
    b[0] = [Math.min(b[0][0], lo[0]), Math.min(b[0][1], lo[1])];
    b[1] = [Math.max(b[1][0], hi[0]), Math.max(b[1][1], hi[1])];
  }
  const [x0, y0] = [b[0][0] - margin, b[0][1] - margin];
  const [w, h] = [b[1][0] - b[0][0] + 2 * margin, b[1][1] - b[0][1] + 2 * margin];
  // Model y up becomes SVG y down: every y is written negated.
  const pt = (q: Vec2) => `${n2(q[0])} ${n2(-q[1])}`;
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n2(x0)} ${n2(-(y0 + h))} ${n2(w)} ${n2(h)}" width="${n2(w / s)}mm" height="${n2(h / s)}mm" data-view="${escape(d.viewId)}" data-scale="1:${s}">`,
    `<title>${escape(d.name)} 1:${s}</title>`,
    '<style>',
    `.cut{stroke:#000;stroke-width:${n2(p.cutStrokeMm * s)};stroke-linejoin:miter;fill-rule:evenodd;fill:#bdbdbd}`,
    '.m-concrete{fill:#9e9e9e}.m-masonry{fill:#c48b6a}.m-metal{fill:#5f6b7a}.m-wood{fill:#d8b07a}.m-glass{fill:#bfe3f2}.m-insulation{fill:#f2e6a0}.m-finish{fill:#e6e6e6}.m-other{fill:#bdbdbd}',
    '.cut.cut-open{fill:none}',
    `.seen{stroke:#000;stroke-width:${n2(p.seenStrokeMm * s)};fill:none}`,
    `.door-leaf,.door-swing,.window-mark{stroke:#000;stroke-width:${n2(p.symbolStrokeMm * s)};fill:none}`,
    `.grid{stroke:#555;stroke-width:${n2(p.thinStrokeMm * s)};stroke-dasharray:${n2(6 * s)} ${n2(1.5 * s)} ${n2(1 * s)} ${n2(1.5 * s)};fill:none}`,
    `.grid-bubble{stroke:#555;stroke-width:${n2(p.thinStrokeMm * s)};fill:#fff}`,
    `.level,.dimension{stroke:#333;stroke-width:${n2(p.thinStrokeMm * s)};fill:none}`,
    `text{font-family:sans-serif;font-size:${n2(p.textMm * s)}px;fill:#000;dominant-baseline:middle}`,
    '</style>',
  );
  const idAttr = (id?: string) => (id ? ` data-id="${escape(id)}"` : '');
  for (const it of d.items) {
    switch (it.type) {
      case 'polygon': {
        const path = it.loops
          .filter((l) => l.length >= 2)
          .map((l) => `M${l.map(pt).join('L')}Z`)
          .join('');
        if (path) out.push(`<path class="${it.cls}" data-id="${escape(it.id)}" d="${path}"/>`);
        const open = (it.open ?? []).map((l) => `M${l.map(pt).join('L')}`).join('');
        if (open)
          out.push(`<path class="${it.cls} cut-open" data-id="${escape(it.id)}" d="${open}"/>`);
        break;
      }
      case 'segments': {
        if (!it.points.length) break;
        const parts: string[] = [];
        for (let i = 0; i + 3 < it.points.length; i += 4)
          parts.push(
            `M${pt([it.points[i]!, it.points[i + 1]!])}L${pt([it.points[i + 2]!, it.points[i + 3]!])}`,
          );
        out.push(`<path class="${it.cls}" d="${parts.join('')}"/>`);
        break;
      }
      case 'line':
        out.push(`<path class="${it.cls}"${idAttr(it.id)} d="M${pt(it.a)}L${pt(it.b)}"/>`);
        break;
      case 'arc': {
        const a: Vec2 = [
          it.center[0] + it.radius * Math.cos(it.start),
          it.center[1] + it.radius * Math.sin(it.start),
        ];
        const e: Vec2 = [
          it.center[0] + it.radius * Math.cos(it.end),
          it.center[1] + it.radius * Math.sin(it.end),
        ];
        let sweep = it.end - it.start;
        while (sweep < 0) sweep += 2 * Math.PI;
        // Counter-clockwise in model space is clockwise once y is flipped (sweep flag 0).
        out.push(
          `<path class="${it.cls}"${idAttr(it.id)} d="M${pt(a)}A${n2(it.radius)} ${n2(it.radius)} 0 ${sweep > Math.PI ? 1 : 0} 0 ${pt(e)}"/>`,
        );
        break;
      }
      case 'circle':
        out.push(
          `<circle class="${it.cls}" cx="${n2(it.center[0])}" cy="${n2(-it.center[1])}" r="${n2(it.radius)}"/>`,
        );
        break;
      case 'text':
        out.push(
          `<text class="${it.cls}"${idAttr(it.id)} x="${n2(it.at[0])}" y="${n2(-it.at[1])}" text-anchor="${it.anchor}">${escape(it.text)}</text>`,
        );
        break;
    }
  }
  for (const f of failures)
    out.push(
      `<text class="failed" x="${n2(f.at[0])}" y="${n2(-f.at[1])}" text-anchor="start">${escape(f.text)}</text>`,
    );
  out.push('</svg>');
  const svg = out.join('\n');
  // Escaped names and IDs can grow a drawing past its limit with few primitives.
  if (new TextEncoder().encode(svg).length > bimDrawingLimits.svgBytes)
    throw new Error('drawing-too-large');
  return svg;
}
