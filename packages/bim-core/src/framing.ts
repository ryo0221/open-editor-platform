import { type BimDerived, deriveBim } from './derive';
import {
  bimDrawingPaper,
  bimDrawingSymbols,
  bimElementBox,
  bimViewFrame,
  type BimDrawing,
  type BimDrawingItem,
} from './drawing';
import { add, arcOf, arcPoint, cross, dot, left, scale, sub, unit } from './geometry';
import { bimSchedule } from './schedule';
import { bimClipRegion, bimColumnSection } from './section-cut';
import { bimProfileLoops, bimRoofPlanes, bimSectionAxes } from './solids';
import type {
  BimDocument,
  BimDrawingScale,
  BimLoop,
  BimProfile,
  BimView,
  Vec2,
  Vec3,
} from './model';

/**
 * DW5b (docs/cad/drawing-editor.md, 施工図): the construction drawings a building version gives
 * besides its own plans and sections. An elevation (立面図) is a section from outside that cuts
 * nothing and sees the whole building; a framing plan (伏図) draws one floor's beams and members
 * as centre lines with their marks (the type's name) over the columns that hold it up; a framing
 * elevation (軸組図) draws the columns, beams and members along a grid axis as centre lines in
 * their heights, a leaning or sloping one as a slanted line.
 */

/** Which side an elevation is seen from: the model's −y (front), +y, −x (left) or +x. */
export const bimElevationSides = ['front', 'rear', 'left', 'right'] as const;
export type BimElevationSide = (typeof bimElevationSides)[number];
export const bimElevationNames: Record<BimElevationSide, string> = {
  front: '正面立面図',
  rear: '背面立面図',
  left: '左側立面図',
  right: '右側立面図',
};

/** The box of every element's solid (what bounds it), or undefined for an empty building. */
function buildingBox(doc: BimDocument, derived: BimDerived): [Vec3, Vec3] | undefined {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const e of doc.elements) {
    const b = bimElementBox(doc, derived, e.id) ?? partBox(doc, derived, e.id);
    if (!b) continue;
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, b[0][k]!);
      hi[k] = Math.max(hi[k]!, b[1][k]!);
    }
  }
  return lo[0] === Infinity ? undefined : [lo, hi];
}

/**
 * A placed CAD part's box: its type's bounds (as the Host reported them for the version) turned
 * and moved into place (Codex on #1238). `bimElementBox` has none: the part's solid is the
 * Host's.
 */
function partBox(doc: BimDocument, derived: BimDerived, id: string): [Vec3, Vec3] | undefined {
  const shape = derived.shapes.get(id);
  if (shape?.kind !== 'part') return undefined;
  const el = doc.elements.find((e) => e.id === id);
  const type = el && 'typeId' in el ? doc.types.find((t) => t.id === el.typeId) : undefined;
  if (type?.kind !== 'part') return undefined;
  const { min, max } = type.hintBounds;
  const c = Math.cos(shape.rotationRad);
  const sn = Math.sin(shape.rotationRad);
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? max[0] : min[0];
    const y = i & 2 ? max[1] : min[1];
    const z = i & 4 ? max[2] : min[2];
    const p: Vec3 = [shape.at[0] + c * x - sn * y, shape.at[1] + sn * x + c * y, shape.zBase + z];
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, p[k]!);
      hi[k] = Math.max(hi[k]!, p[k]!);
    }
  }
  return [lo, hi];
}

/** How far outside the building an elevation stands (its line misses every solid). */
const STAND_OFF = 100;
/** How far its line runs past the building each way (its level lines reach that far). */
const RUN_PAST = 2000;

/**
 * An elevation as a section the building editor draws (`drawBim`): its line stands just outside
 * the building's box on the side seen, runs past it each way, and looks across the whole box.
 * The level marks and the grid axes that reach the line come with it, as in a section. None for
 * a building with no solid.
 */
export function bimElevationView(
  doc: BimDocument,
  side: BimElevationSide,
  scaleN: BimDrawingScale,
  derived: BimDerived = deriveBim(doc),
): BimView | undefined {
  const box = buildingBox(doc, derived);
  if (!box) return undefined;
  const [[x0, y0], [x1, y1]] = box;
  const [xa, xb] = [x0 - RUN_PAST, x1 + RUN_PAST];
  const [ya, yb] = [y0 - RUN_PAST, y1 + RUN_PAST];
  // Each looks to the left of its line, so the drawing's x runs to the viewer's right.
  const line: [Vec2, Vec2] =
    side === 'front'
      ? [
          [xa, y0 - STAND_OFF],
          [xb, y0 - STAND_OFF],
        ]
      : side === 'rear'
        ? [
            [xb, y1 + STAND_OFF],
            [xa, y1 + STAND_OFF],
          ]
        : side === 'right'
          ? [
              [x1 + STAND_OFF, ya],
              [x1 + STAND_OFF, yb],
            ]
          : [
              [x0 - STAND_OFF, yb],
              [x0 - STAND_OFF, ya],
            ];
  const across = side === 'front' || side === 'rear' ? y1 - y0 : x1 - x0;
  return {
    id: `elevation-${side}`,
    kind: 'section',
    name: bimElevationNames[side],
    line,
    direction: 'left',
    depthMm: across + 2 * STAND_OFF,
    scale: scaleN,
  };
}

/**
 * An elevation's grid axes, with their dimensions and the storeys' heights (DW5c): every axis across its line (wherever it ends: an elevation stands
 * outside the building, past the axes' ends), upright from below the lowest level to above the
 * highest, with its bubble on top. The building editor's section draws only the axes its line
 * crosses, so a Host puts these in their place.
 */
export function bimElevationAxes(doc: BimDocument, view: BimView): BimDrawingItem[] {
  if (view.kind !== 'section') return [];
  const s = view.scale;
  const [la, lb] = view.line;
  const lu = unit(sub(lb, la));
  const len = Math.hypot(lb[0] - la[0], lb[1] - la[1]);
  const frame = bimViewFrame(doc, view);
  const xs: { x: number; label: string }[] = [];
  for (const g of doc.grids) {
    const gu = sub(g.end, g.start);
    const denom = cross(lu, gu);
    if (Math.abs(denom) < 1e-9) continue;
    const t = cross(sub(g.start, la), gu) / denom;
    if (t < -1e-9 || t > len + 1e-9) continue;
    const p = add(la, scale(lu, t));
    xs.push({ x: frame.toView([p[0], p[1], 0])[0], label: g.label });
  }
  const o = bimDrawingPaper.gridOverrunMm * s;
  const r = bimDrawingPaper.bubbleRadiusMm * s;
  const zs = doc.levels.map((l) => l.elevationMm);
  const z0 = Math.min(0, ...zs) - o;
  const z1 = Math.max(0, ...zs) + 3000 + o;
  const items: BimDrawingItem[] = [];
  xs.sort((a, b) => a.x - b.x || a.label.localeCompare(b.label));
  // DW5c: the axes' spacings and overall below, the storeys' heights on the left.
  const t = bimDrawingPaper.textMm * s;
  items.push(
    ...chainDimension(
      xs.map((c) => c.x),
      z0 - t * 2,
      'x',
      s,
      true,
    ),
  );
  // Left of the first axis, or with none, left of the building (the line runs past it by
  // RUN_PAST each way; Codex on #1240).
  const ends = [la, lb].map((p) => frame.toView([p[0], p[1], 0])[0]);
  const left0 = xs.length ? xs[0]!.x : Math.min(...ends) + RUN_PAST;
  items.push(...chainDimension(zs, left0 - o - t * 4, 'y', s));
  for (const c of xs) {
    items.push({ type: 'line', a: [c.x, z0], b: [c.x, z1], cls: 'grid' });
    items.push({ type: 'circle', center: [c.x, z1 + r], radius: r, cls: 'grid-bubble' });
    items.push({
      type: 'text',
      at: [c.x, z1 + r],
      text: c.label,
      anchor: 'middle',
      cls: 'grid-label',
    });
  }
  return items;
}

/**
 * DW5c: a chain of dimensions through `points` (sorted, model mm along x or y), drawn on the
 * line `at` across: the building editor's dimension lines, ticks and text. With `total`, the
 * overall length on a second line further out (`out` is the side, −1 below or left).
 */
function chainDimension(
  points: number[],
  at: number,
  along: 'x' | 'y',
  s: BimDrawingScale,
  total = false,
  out: 1 | -1 = -1,
): BimDrawingItem[] {
  const ps = [...new Set(points.map((p) => Math.round(p * 1000) / 1000))].sort((a, b) => a - b);
  if (ps.length < 2) return [];
  const t = bimDrawingPaper.textMm * s;
  const pt = (p: number, q: number): Vec2 => (along === 'x' ? [p, q] : [q, p]);
  const items: BimDrawingItem[] = [];
  const row = (stops: number[], q: number) => {
    items.push({ type: 'line', a: pt(stops[0]!, q), b: pt(stops.at(-1)!, q), cls: 'dimension' });
    for (const p of stops)
      items.push({
        type: 'line',
        a: pt(p - t * 0.3, q - t * 0.3),
        b: pt(p + t * 0.3, q + t * 0.3),
        cls: 'dimension',
      });
    for (let i = 1; i < stops.length; i++) {
      const m = (stops[i - 1]! + stops[i]!) / 2;
      const text = String(Math.round(stops[i]! - stops[i - 1]!));
      items.push(
        along === 'x'
          ? { type: 'text', at: [m, q + t * 0.4], text, anchor: 'middle', cls: 'dimension-text' }
          : {
              type: 'text',
              at: [q - t * 0.4, m - t * 0.35],
              text,
              anchor: 'end',
              cls: 'dimension-text',
            },
      );
    }
  };
  row(ps, at);
  if (total && ps.length > 2) row([ps[0]!, ps.at(-1)!], at + out * t * 3);
  return items;
}

/** How far from a floor (mm) a member's end may be and still lie on it. */
const ON_FLOOR = 1;

/** A loop's points with each arc in 16 straight pieces a half turn (a section on paper). */
function flatLoop(loop: BimLoop): Vec2[] {
  const out: Vec2[] = [];
  loop.forEach((v, i) => {
    const p: Vec2 = [v[0], v[1]];
    out.push(p);
    const b = v[2] ?? 0;
    if (!b) return;
    const w = loop[(i + 1) % loop.length]!;
    const arc = arcOf(p, [w[0], w[1]], b);
    const n = Math.max(2, Math.ceil((Math.abs(arc.sweep) / Math.PI) * 16));
    for (let k = 1; k < n; k++) out.push(arcPoint(arc, k / n));
  });
  return out;
}

/** The depth of a section across its axis (what a beam hangs below its top by). */
function profileDepth(p: BimProfile): number {
  return p.shape === 'circle' || p.shape === 'pipe' ? p.diameterMm : p.depthMm;
}
/** Each element's mark: its type's name (the member list's 符号). */
function markOf(doc: BimDocument, typeId: string): string {
  return doc.types.find((t) => t.id === typeId)?.name ?? typeId;
}

/** The symbols of a plan of `levelId` of these classes only (grids and their dimensions). */
function gridSymbols(doc: BimDocument, levelId: string, s: BimDrawingScale, derived: BimDerived) {
  const keep = new Set(['grid', 'grid-bubble', 'grid-label', 'dimension', 'dimension-text']);
  const plan: BimView = {
    id: 'framing',
    kind: 'plan',
    name: '',
    level: levelId,
    cutHeightMm: 1,
    depthMm: 1,
    scale: s,
  };
  return bimDrawingSymbols(doc, plan, derived).filter((i) => 'cls' in i && keep.has(i.cls));
}

/**
 * The framing plan of a level (伏図): the beams whose top is at the level and the members with
 * both ends on it, as centre lines marked with their type's name; the columns that reach the
 * floor from below, as their section at its height; the grid axes and their dimensions.
 */
export function bimFramingDrawing(
  doc: BimDocument,
  levelId: string,
  s: BimDrawingScale,
  derived: BimDerived = deriveBim(doc),
): BimDrawing {
  const level = doc.levels.find((l) => l.id === levelId);
  const items: BimDrawingItem[] = [];
  const failed: BimDrawing['failed'] = [];
  const name = `${level?.name ?? levelId} 伏図`;
  if (!level) return { viewId: `framing-${levelId}`, kind: 'plan', name, scale: s, items, failed };
  const z = level.elevationMm;
  const gap = bimDrawingPaper.textMm * s * 0.8;
  const marked = (id: string, a: Vec2, b: Vec2, mark: string) => {
    items.push({ type: 'line', a, b, cls: 'member', id });
    const d = sub(b, a);
    if (Math.hypot(d[0], d[1]) < 1e-6) return;
    // Over the line (on its upper side, or its left on a vertical line).
    let n = left(unit(d));
    if (n[1] < 0 || (Math.abs(n[1]) < 1e-9 && n[0] > 0)) n = scale(n, -1);
    items.push({
      type: 'text',
      at: add(scale(add(a, b), 0.5), scale(n, gap)),
      text: mark,
      anchor: 'middle',
      cls: 'member-mark',
      id,
    });
  };
  for (const e of doc.elements) {
    const shape = derived.shapes.get(e.id);
    if (e.kind === 'beam') {
      if (shape?.kind !== 'beam') {
        if (e.top.level === levelId) failed.push({ id: e.id, code: 'not-derived' });
        continue;
      }
      // On the floor by its heights, however they are written (Codex on #1238).
      if (
        Math.abs(shape.zTop - z) > ON_FLOOR ||
        Math.abs((shape.zTopEnd ?? shape.zTop) - z) > ON_FLOOR
      )
        continue;
      marked(e.id, shape.start, shape.end, markOf(doc, e.typeId));
    } else if (e.kind === 'member') {
      if (shape?.kind !== 'member') {
        failed.push({ id: e.id, code: 'not-derived' });
        continue;
      }
      // Both ends on the floor, however their heights are written (Codex on #1238).
      if (Math.abs(shape.start[2] - z) > ON_FLOOR || Math.abs(shape.end[2] - z) > ON_FLOOR)
        continue;
      marked(
        e.id,
        [shape.start[0], shape.start[1]],
        [shape.end[0], shape.end[1]],
        markOf(doc, e.typeId),
      );
    } else if (e.kind === 'column' && shape?.kind === 'column') {
      // Under the floor and reaching it: its section where it meets the floor. A leaning
      // column's top cap tilts, so it may reach above its axis's top: its section's reach at the
      // top, scaled, bounds it; the caps then cut the section exactly (Codex on #1238).
      const reach =
        Math.max(...flatLoop(bimProfileLoops(shape.profile).outer).map((q) => Math.hypot(...q))) *
        (shape.topScale ?? 1);
      const tilted = shape.topAt ? reach : 0;
      if (!(shape.zBase < z - 1 && shape.zTop + tilted >= z - 1)) continue;
      // Cut off by a roof below the floor: none; cut across it: what is left (Codex on #1238).
      const roof = shape.clipBy ? derived.shapes.get(shape.clipBy) : undefined;
      const unders =
        roof?.kind === 'roof' ? roof.faces.map((f) => bimRoofPlanes(roof, f).under) : [];
      // Its solid's own section by the floor: a leaning column's cut is longer than its
      // section, its caps square to its axis end it, a taper narrows it; round, hollow or an H
      // as it is, its voids open (Codex on #1238).
      const { outer, holes } = bimProfileLoops(shape.profile);
      let loops = bimColumnSection(
        bimSectionAxes(shape),
        shape.topScale ?? 1,
        [outer, ...holes].map(flatLoop),
        z,
      );
      // Then what a roof leaves of it, its boundary rebuilt along the cut.
      for (const u of unders) {
        if (!loops) break;
        loops = bimClipRegion(
          loops,
          (q) => u.n[0] * (q[0] - u.p[0]) + u.n[1] * (q[1] - u.p[1]) + u.n[2] * (z - u.p[2]),
        );
      }
      if (!loops) {
        failed.push({ id: e.id, code: 'section-open' });
        continue;
      }
      if (!loops.length) continue;
      items.push({ type: 'polygon', loops, cls: 'cut cut-column', id: e.id });
    }
  }
  items.push(...gridSymbols(doc, levelId, s, derived));
  return { viewId: `framing-${levelId}`, kind: 'plan', name, scale: s, items, failed };
}

/**
 * The framing elevation along a grid axis (軸組図): the columns, beams and members within
 * `bandMm` of the axis (every one, with 0) as centre lines, along the axis from its start and up
 * in their heights, marked with their type's name; the levels across, and the grid axes that
 * cross it, upright with their bubbles.
 */
export function bimFrameDrawing(
  doc: BimDocument,
  gridId: string,
  bandMm: number,
  s: BimDrawingScale,
  derived: BimDerived = deriveBim(doc),
): BimDrawing {
  const g = doc.grids.find((x) => x.id === gridId);
  const items: BimDrawingItem[] = [];
  const failed: BimDrawing['failed'] = [];
  const name = `${g?.label ?? gridId} 通り軸組図`;
  if (!g) return { viewId: `frame-${gridId}`, kind: 'section', name, scale: s, items, failed };
  const u = unit(sub(g.end, g.start));
  const n = left(u);
  const along = (p: Vec2) => dot(sub(p, g.start), u);
  const near = (p: Vec2) => bandMm <= 0 || Math.abs(dot(sub(p, g.start), n)) <= bandMm + 1e-6;
  const gap = bimDrawingPaper.textMm * s * 0.8;
  const xs: number[] = [along(g.start), along(g.end)];
  const zs: number[] = [];
  const marked = (id: string, a: Vec2, b: Vec2, mark: string) => {
    items.push({ type: 'line', a, b, cls: 'member', id });
    xs.push(a[0], b[0]);
    zs.push(a[1], b[1]);
    const d = sub(b, a);
    if (Math.hypot(d[0], d[1]) < 1e-6) return;
    let m = left(unit(d));
    if (m[1] < 0 || (Math.abs(m[1]) < 1e-9 && m[0] > 0)) m = scale(m, -1);
    items.push({
      type: 'text',
      at: add(scale(add(a, b), 0.5), scale(m, gap)),
      text: mark,
      anchor: 'middle',
      cls: 'member-mark',
      id,
    });
  };
  for (const e of doc.elements) {
    if (e.kind !== 'column' && e.kind !== 'beam' && e.kind !== 'member') continue;
    const shape = derived.shapes.get(e.id);
    if (!shape) {
      failed.push({ id: e.id, code: 'not-derived' });
      continue;
    }
    const mark = markOf(doc, e.typeId);
    if (shape.kind === 'column') {
      const top = shape.topAt ?? shape.at;
      if (!near(shape.at) || !near(top)) continue;
      // Its axis as far as a roof that cuts it leaves it (Codex on #1238).
      const roof = shape.clipBy ? derived.shapes.get(shape.clipBy) : undefined;
      const unders =
        roof?.kind === 'roof' ? roof.faces.map((f) => bimRoofPlanes(roof, f).under) : [];
      const a3: Vec3 = [shape.at[0], shape.at[1], shape.zBase];
      const b3: Vec3 = [top[0], top[1], shape.zTop];
      let [t0, t1] = [0, 1];
      for (const p of unders) {
        const side = (q: Vec3) =>
          p.n[0] * (q[0] - p.p[0]) + p.n[1] * (q[1] - p.p[1]) + p.n[2] * (q[2] - p.p[2]);
        const [da, db] = [side(a3), side(b3)];
        if (da > 0 && db > 0) t1 = -1;
        else if (da > 0) t0 = Math.max(t0, da / (da - db));
        else if (db > 0) t1 = Math.min(t1, da / (da - db));
      }
      if (t1 - t0 < 1e-9) continue;
      const at3 = (t: number): Vec2 => {
        const q: Vec2 = [a3[0] + (b3[0] - a3[0]) * t, a3[1] + (b3[1] - a3[1]) * t];
        return [along(q), a3[2] + (b3[2] - a3[2]) * t];
      };
      marked(e.id, at3(t0), at3(t1), mark);
    } else if (shape.kind === 'beam') {
      if (!near(shape.start) || !near(shape.end)) continue;
      const half = profileDepth(shape.profile) / 2;
      marked(
        e.id,
        [along(shape.start), shape.zTop - half],
        [along(shape.end), (shape.zTopEnd ?? shape.zTop) - half],
        mark,
      );
    } else if (shape.kind === 'member') {
      const a: Vec2 = [shape.start[0], shape.start[1]];
      const b: Vec2 = [shape.end[0], shape.end[1]];
      if (near(a) && near(b))
        marked(e.id, [along(a), shape.start[2]], [along(b), shape.end[2]], mark);
    }
  }
  // The grid axes that cross this one (on its line, wherever along it).
  const crossings: { x: number; label: string }[] = [];
  for (const o of doc.grids) {
    if (o.id === g.id) continue;
    const ou = sub(o.end, o.start);
    const denom = cross(u, ou);
    if (Math.abs(denom) < 1e-9) continue;
    const t = cross(sub(o.start, g.start), ou) / denom;
    crossings.push({ x: t, label: o.label });
    xs.push(t);
  }
  const s0 = bimDrawingPaper.gridOverrunMm * s;
  const levels = [...doc.levels].sort((a, b) => a.elevationMm - b.elevationMm);
  zs.push(...levels.map((l) => l.elevationMm));
  const x0 = Math.min(...xs) - s0;
  const x1 = Math.max(...xs) + s0;
  const z0 = Math.min(0, ...zs) - s0;
  const z1 = Math.max(0, ...zs) + s0;
  for (const l of levels) {
    items.push({ type: 'line', a: [x0, l.elevationMm], b: [x1, l.elevationMm], cls: 'level' });
    const sign = l.elevationMm > 0 ? '+' : l.elevationMm < 0 ? '−' : '±';
    items.push({
      type: 'text',
      at: [x1 + bimDrawingPaper.textMm * s * 0.5, l.elevationMm + bimDrawingPaper.textMm * s * 0.3],
      text: `${l.name} ${sign}${Math.round(Math.abs(l.elevationMm))}`,
      anchor: 'start',
      cls: 'level-label',
      id: l.id,
    });
  }
  crossings.sort((a, b) => a.x - b.x || a.label.localeCompare(b.label));
  // DW5c: the axes' spacings and overall below, the storeys' heights on the left.
  const t = bimDrawingPaper.textMm * s;
  items.push(
    ...chainDimension(
      crossings.map((c) => c.x),
      z0 - t * 2,
      'x',
      s,
      true,
    ),
  );
  items.push(
    ...chainDimension(
      levels.map((l) => l.elevationMm),
      x0 - t * 4,
      'y',
      s,
    ),
  );
  const r = bimDrawingPaper.bubbleRadiusMm * s;
  for (const c of crossings) {
    items.push({ type: 'line', a: [c.x, z0], b: [c.x, z1], cls: 'grid' });
    items.push({ type: 'circle', center: [c.x, z1 + r], radius: r, cls: 'grid-bubble' });
    items.push({
      type: 'text',
      at: [c.x, z1 + r],
      text: c.label,
      anchor: 'middle',
      cls: 'grid-label',
    });
  }
  return { viewId: `frame-${gridId}`, kind: 'section', name, scale: s, items, failed };
}

/** DW5c: one row of the member list (部材リスト): a column, beam or member type. */
export interface BimMemberRow {
  mark: string;
  kind: string;
  section: string;
  count: number;
  /** Absent when no element of the row has a length. */
  lengthMm?: number;
}

const memberKinds: Record<string, string> = { column: '柱', beam: '梁', member: '部材' };
const n = (v: number) => String(Math.round(v * 10) / 10);

/** A section as it is written on drawings: `H-700×300×13×24`, `□-400×400×19`, `φ508×12`. */
export function bimProfileText(p: BimProfile): string {
  switch (p.shape) {
    case 'rect':
      return `${n(p.widthMm)}×${n(p.depthMm)}`;
    case 'circle':
      return `φ${n(p.diameterMm)}`;
    case 'h':
      return `H-${n(p.depthMm)}×${n(p.widthMm)}×${n(p.webMm)}×${n(p.flangeMm)}`;
    case 'l':
      return `L-${n(p.depthMm)}×${n(p.widthMm)}×${n(p.thicknessMm)}`;
    case 'channel':
      return `[-${n(p.depthMm)}×${n(p.widthMm)}×${n(p.webMm)}×${n(p.flangeMm)}`;
    case 'box':
      return `□-${n(p.depthMm)}×${n(p.widthMm)}×${n(p.wallMm)}`;
    case 'pipe':
      return `φ${n(p.diameterMm)}×${n(p.wallMm)}`;
  }
}

/**
 * DW5c: the member list (部材リスト) of a building version: one row per column, beam and member
 * type it places (all levels together), with how many and their total length, from the
 * building's schedule. Columns first, then beams, then members, each by mark.
 */
export function bimMemberList(
  doc: BimDocument,
  derived: BimDerived = deriveBim(doc),
): BimMemberRow[] {
  const rows = new Map<string, BimMemberRow & { order: number }>();
  for (const r of bimSchedule(doc, derived).rows) {
    const kind = memberKinds[r.kind];
    if (!kind || !r.typeId) continue;
    const type = doc.types.find((t) => t.id === r.typeId);
    if (!type || !('profile' in type)) continue;
    const row = rows.get(r.typeId) ?? {
      mark: type.name,
      kind,
      section: bimProfileText(type.profile),
      count: 0,
      order: Object.keys(memberKinds).indexOf(r.kind),
    };
    row.count += r.count;
    if (r.lengthMm !== undefined) row.lengthMm = (row.lengthMm ?? 0) + r.lengthMm;
    rows.set(r.typeId, row);
  }
  return [...rows.values()]
    .sort((a, b) => a.order - b.order || (a.mark < b.mark ? -1 : a.mark > b.mark ? 1 : 0))
    .map(({ order: _, ...r }) => r);
}
