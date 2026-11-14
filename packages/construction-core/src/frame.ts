/**
 * CS4 (docs/cad/construction-site.md, CS-U5): the frame that stands on a day, as beam elements for
 * the Host (CalculiX), and the loads on it. Columns, beams and `member`s of the BIM version are
 * lines along their axes with their sections (`BimProfile`), joined rigidly where their ends meet
 * (an end on another member's span splits that member there). Beams run at their top level, the
 * floor's, so they meet the columns' tops; the eccentricity is left out. The supports are the
 * column feet at the foundation level (the lowest column foot of the building), fixed.
 *
 * Loads: the members' own weight; each standing slab's weight (also one being cast: wet concrete
 * on the frame), and the site loads of the tasks running that day (kN/m², materials stocked), both
 * shared out over the plan to the nearest frame node at the slab's level (tributary areas). The
 * slab itself adds no stiffness. Pieces that reach no support are left out and named.
 *
 * Also the crane foundations' reactions from the lifts (CS3): the crane's own mass and the load,
 * and the load's moment about the mast.
 *
 * Pure data and arithmetic: no React, no kernel, no Host.
 */
import {
  bimElementMass,
  bimSectionAxes,
  loopArea,
  sampleLoop,
  type BimLoop,
  type BimDerived,
  type BimDocument,
  type BimProfile,
} from '@editor-platform/bim-core';
import type { FrameModel, FrameSection } from '@editor-platform/geometry-fem';
import { craneStands, liftTimes, type CraneWorld } from './crane';
import type { ConstructionDiagnostic, ConstructionDocument } from './model';
import { siteOnDay, taskPhase, type ConstructionSchedule } from './schedule';
import type { Point3 } from './site';

// ---------------------------------------------------------------------------------------------
// Site loads

/** A load laid on slabs while a task runs (materials stocked), uniform over each slab. */
export interface SiteLoad {
  id: string;
  name: string;
  /** Lies on the slabs while this task runs. */
  taskId: string;
  /** The slabs it lies on (BIM element IDs). */
  elementIds: string[];
  /** kN/m². */
  kNm2: number;
}

export const siteLoadLimits = Object.freeze({ loads: 500, elements: 1000, kNm2: 1000 });

type Rec = Record<string, unknown>;
const record = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validateSiteLoads(
  loads: unknown,
  tasks: ReadonlyMap<string, unknown>,
  usedIds: Set<string>,
  isId: (v: unknown) => v is string,
  isText: (v: unknown) => v is string,
): ConstructionDiagnostic[] {
  const out: ConstructionDiagnostic[] = [];
  const bad = (code: string, path: string, message = code) => out.push({ code, path, message });
  if (loads === undefined) return out;
  if (!Array.isArray(loads) || loads.length > siteLoadLimits.loads)
    return [
      { code: 'limit-exceeded', path: '$.site.loads', message: `at most ${siteLoadLimits.loads}` },
    ];
  loads.forEach((l, i) => {
    const p = `$.site.loads[${i}]`;
    if (!record(l)) return bad('site-load', p);
    for (const k of Object.keys(l))
      if (!['id', 'name', 'taskId', 'elementIds', 'kNm2'].includes(k))
        bad('unknown-key', `${p}.${k}`, k);
    if (!isId(l.id)) bad('id', `${p}.id`);
    else if (usedIds.has(l.id)) bad('duplicate-id', `${p}.id`, `${l.id} is used twice`);
    else usedIds.add(l.id);
    if (!isText(l.name)) bad('name', `${p}.name`);
    if (!isId(l.taskId)) bad('id', `${p}.taskId`);
    else if (!tasks.has(l.taskId)) bad('task-missing', `${p}.taskId`, l.taskId);
    const ids = l.elementIds;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > siteLoadLimits.elements ||
      !ids.every(isId) ||
      new Set(ids).size !== ids.length
    )
      bad('site-load', `${p}.elementIds`, `1 to ${siteLoadLimits.elements} slab IDs, each once`);
    if (
      !(
        typeof l.kNm2 === 'number' &&
        Number.isFinite(l.kNm2) &&
        l.kNm2 > 0 &&
        l.kNm2 <= siteLoadLimits.kNm2
      )
    )
      bad('site-load', `${p}.kNm2`, `above 0 and at most ${siteLoadLimits.kNm2} kN/m²`);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// The frame

/** Gravity (mm/s²). */
export const gravity = 9810;
/** Ends this close are one node; an end this close to a span splits it (mm). */
export const frameTolerance = 10;
/** A slab's load goes to frame nodes this close to its top level (mm). */
export const slabLevelTolerance = 600;

export interface FrameWorld {
  bim: BimDocument;
  derived: BimDerived;
  /** Measured quantities for elements only the kernel measures (slabs clipped by a roof …). */
  kernelQuantities?: ReadonlyMap<string, Record<string, number>>;
}

export interface FrameMember {
  elementId: string;
  kind: 'column' | 'beam' | 'member';
  /** Element indices (model order, group by group). */
  elements: number[];
  nodes: number[];
  /**
   * A channel or an angle (its section taken about its depth and width, `frameSection`), or a
   * tapered column (stepped: each element carries the section at its middle).
   */
  approximate: boolean;
}

export interface ConstructionFrame {
  /** Undefined when nothing stands that reaches a support. */
  model?: FrameModel;
  members: FrameMember[];
  /** Total gravity load (N): the members' own weight and the slab and site loads. */
  totalLoadN: number;
  /** Slab weights and site loads applied (N), by element. */
  slabLoads: { elementId: string; selfN: number; siteN: number }[];
  /** What was left out, and why. */
  notes: ConstructionDiagnostic[];
}

/** Area, second moments and the rest of a rectangle `d` deep (along the depth) and `w` wide. */
function rectangle(d: number, w: number): FrameSection {
  const [a, b] = d >= w ? [d, w] : [w, d];
  return {
    area: d * w,
    i11: (w * d ** 3) / 12,
    i22: (d * w ** 3) / 12,
    // Saint-Venant's torsion constant of a solid rectangle (Roark).
    torsion: a * b ** 3 * (1 / 3 - 0.21 * (b / a) * (1 - b ** 4 / (12 * a ** 4))),
    c1: d / 2,
    c2: w / 2,
  };
}

/**
 * The section properties CalculiX takes for a BIM profile, depth along the depth direction (a
 * beam's depth upright). `approximate` marks a channel or an angle: their principal axes and shear
 * centre are not those of the depth and width, and are taken as if they were.
 */
export function frameSection(p: BimProfile): { section: FrameSection; approximate: boolean } {
  switch (p.shape) {
    case 'rect':
      return { section: rectangle(p.depthMm, p.widthMm), approximate: false };
    case 'circle': {
      const d = p.diameterMm;
      const i = (Math.PI * d ** 4) / 64;
      return {
        section: {
          area: (Math.PI * d * d) / 4,
          i11: i,
          i22: i,
          torsion: 2 * i,
          c1: d / 2,
          c2: d / 2,
          round: true,
        },
        approximate: false,
      };
    }
    case 'pipe': {
      const [d, t] = [p.diameterMm, p.wallMm];
      const di = d - 2 * t;
      const i = (Math.PI * (d ** 4 - di ** 4)) / 64;
      return {
        section: {
          area: (Math.PI * (d * d - di * di)) / 4,
          i11: i,
          i22: i,
          torsion: 2 * i,
          c1: d / 2,
          c2: d / 2,
          round: true,
        },
        approximate: false,
      };
    }
    case 'box': {
      const [d, w, t] = [p.depthMm, p.widthMm, p.wallMm];
      return {
        section: {
          area: d * w - (d - 2 * t) * (w - 2 * t),
          i11: (w * d ** 3 - (w - 2 * t) * (d - 2 * t) ** 3) / 12,
          i22: (d * w ** 3 - (d - 2 * t) * (w - 2 * t) ** 3) / 12,
          // Bredt: a thin closed section on its wall's mid-line.
          torsion: (2 * t * (d - t) ** 2 * (w - t) ** 2) / (d + w - 2 * t),
          c1: d / 2,
          c2: w / 2,
        },
        approximate: false,
      };
    }
    case 'h':
    case 'channel': {
      const [d, w, tw, tf] = [p.depthMm, p.widthMm, p.webMm, p.flangeMm];
      const h = d - 2 * tf;
      const area = 2 * w * tf + h * tw;
      const i11 = (w * d ** 3 - (w - tw) * h ** 3) / 12;
      const torsion = (2 * w * tf ** 3 + h * tw ** 3) / 3;
      if (p.shape === 'h')
        return {
          section: {
            area,
            i11,
            i22: (2 * tf * w ** 3 + h * tw ** 3) / 12,
            torsion,
            c1: d / 2,
            c2: w / 2,
          },
          approximate: false,
        };
      // The channel's web at its back (x = 0), flanges to x = w: about the centroid.
      const x = (2 * tf * w * (w / 2) + h * tw * (tw / 2)) / area;
      const i22 = (2 * tf * w ** 3) / 3 + (h * tw ** 3) / 3 - area * x * x;
      return {
        section: { area, i11, i22, torsion, c1: d / 2, c2: Math.max(x, w - x) },
        approximate: true,
      };
    }
    case 'l': {
      // Legs `d` (along the depth) and `w`, both `t` thick, meeting at the corner (0, 0).
      const [d, w, t] = [p.depthMm, p.widthMm, p.thicknessMm];
      const parts = [
        // [area, centre along the depth, centre along the width, size along depth, along width]
        [w * t, t / 2, w / 2, t, w],
        [(d - t) * t, t + (d - t) / 2, t / 2, d - t, t],
      ] as const;
      const area = parts.reduce((s, q) => s + q[0], 0);
      const y = parts.reduce((s, q) => s + q[0] * q[1], 0) / area;
      const z = parts.reduce((s, q) => s + q[0] * q[2], 0) / area;
      const i11 = parts.reduce((s, q) => s + (q[4] * q[3] ** 3) / 12 + q[0] * (q[1] - y) ** 2, 0);
      const i22 = parts.reduce((s, q) => s + (q[3] * q[4] ** 3) / 12 + q[0] * (q[2] - z) ** 2, 0);
      return {
        section: {
          area,
          i11,
          i22,
          torsion: (t ** 3 * (d + w - t)) / 3,
          c1: Math.max(y, d - y),
          c2: Math.max(z, w - z),
        },
        approximate: true,
      };
    }
  }
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

interface Line {
  elementId: string;
  kind: FrameMember['kind'];
  a: V3;
  b: V3;
  section: FrameSection;
  approximate: boolean;
  dir: V3;
  materialKey: string;
  /** A tapered column's top section's size as a share of its base's. */
  topScale?: number;
  /** Whether its material gives no density (its own weight is then not known). */
  weightless: boolean;
}

/** A section scaled linearly by `k` (a tapered column's, similar sections). */
const scaledSection = (s: FrameSection, k: number): FrameSection =>
  k === 1
    ? s
    : {
        ...s,
        area: s.area * k ** 2,
        i11: s.i11 * k ** 4,
        i22: s.i22 * k ** 4,
        torsion: s.torsion * k ** 4,
        c1: s.c1 * k,
        c2: s.c2 * k,
      };

/**
 * The frame lines of the BIM's columns, beams and members, and why any is left out; and the
 * foundation level: the lowest column foot of the building, whether or not that column is in
 * the frame.
 */
function frameLines(world: FrameWorld): {
  lines: Map<string, Line>;
  notes: ConstructionDiagnostic[];
  base: number;
} {
  const { bim, derived } = world;
  const lines = new Map<string, Line>();
  const notes: ConstructionDiagnostic[] = [];
  const types = new Map(bim.types.map((t) => [t.id, t]));
  const materials = new Map(bim.materials.map((m) => [m.id, m]));
  let base = Infinity;
  for (const [id, s] of derived.shapes) {
    if (s.kind !== 'column' && s.kind !== 'beam' && s.kind !== 'member') continue;
    if (s.kind === 'column') base = Math.min(base, s.zBase);
    const el = bim.elements.find((e) => e.id === id);
    const type = el && 'typeId' in el ? types.get(el.typeId) : undefined;
    const material =
      type && 'materialId' in type ? materials.get(type.materialId as string) : undefined;
    if (!material?.youngsModulusMPa) {
      notes.push({
        code: 'frame-material',
        path: id,
        message: `${id}: its material has no Young's modulus`,
      });
      continue;
    }
    if (s.kind === 'column' && s.clipBy) {
      // Cut below a roof by the kernel: its own top is not known here.
      notes.push({
        code: 'frame-clipped',
        path: id,
        message: `${id}: the column is cut by a roof; it is left out of the frame`,
      });
      continue;
    }
    let a: V3, b: V3;
    if (s.kind === 'column') {
      a = [s.at[0], s.at[1], s.zBase];
      b = [(s.topAt ?? s.at)[0], (s.topAt ?? s.at)[1], s.zTop];
    } else if (s.kind === 'beam') {
      a = [s.start[0], s.start[1], s.zTop];
      b = [s.end[0], s.end[1], s.zTopEnd ?? s.zTop];
    } else {
      a = [...s.start];
      b = [...s.end];
    }
    if (Math.hypot(...sub(b, a)) < frameTolerance) continue;
    const { section, approximate } = frameSection(s.profile);
    const taper = s.kind === 'column' ? s.topScale : undefined;
    // The section's depth as the BIM orients it (a leaning column keeps its own convention);
    // `+ 0` keeps −0 out (it would not survive JSON).
    const dir = bimSectionAxes(s).y.map((x) => x + 0) as V3;
    lines.set(id, {
      elementId: id,
      kind: s.kind,
      a,
      b,
      section,
      // A tapered column is stepped: each element carries the section at its middle.
      approximate: approximate || taper !== undefined,
      dir,
      materialKey: material.id,
      ...(taper !== undefined ? { topScale: taper } : {}),
      weightless: material.densityKgM3 === undefined,
    });
  }
  return { lines, notes, base };
}

interface SlabLoad {
  elementId: string;
  /** N/mm² (kN/m² × 1e-3). */
  self: number;
  site: number;
}

/**
 * The frame of the members `standing` holds, with the slab loads given, as a CalculiX frame
 * model; members not reaching a support are left out and named.
 */
export function buildFrame(
  world: FrameWorld,
  standing: (elementId: string) => boolean,
  slabs: readonly SlabLoad[],
): ConstructionFrame {
  const { lines: all, notes, base } = frameLines(world);
  const lines = [...all.values()].filter((l) => standing(l.elementId));
  const material = new Map(world.bim.materials.map((m) => [m.id, m]));
  // Nodes, merged within the tolerance by a grid of cells.
  const coords: number[] = [];
  const cells = new Map<string, number[]>();
  const cell = (x: number) => Math.floor(x / frameTolerance);
  const nodeAt = (p: V3) => {
    const [i, j, k] = p.map(cell) as V3;
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++)
        for (let dk = -1; dk <= 1; dk++)
          for (const q of cells.get(`${i + di},${j + dj},${k + dk}`) ?? [])
            if (
              Math.hypot(
                coords[3 * q]! - p[0],
                coords[3 * q + 1]! - p[1],
                coords[3 * q + 2]! - p[2],
              ) <= frameTolerance
            )
              return q;
    const q = coords.length / 3;
    coords.push(...p);
    const key = `${i},${j},${k}`;
    cells.set(key, [...(cells.get(key) ?? []), q]);
    return q;
  };
  // Where each line is cut: at the ends of the others on its span.
  const ends = lines.flatMap((l) => [l.a, l.b]);
  type Piece = { line: Line; nodes: number[]; ts: number[] };
  const pieces: Piece[] = [];
  for (const l of lines) {
    const d = sub(l.b, l.a);
    const len2 = dot(d, d);
    const cuts = new Set<number>([0, 1]);
    for (const p of ends) {
      const t = dot(sub(p, l.a), d) / len2;
      if (t <= 1e-9 || t >= 1 - 1e-9) continue;
      const q = [0, 1, 2].map((k) => l.a[k]! + d[k]! * t) as V3;
      if (
        Math.hypot(...sub(p, q)) <= frameTolerance &&
        Math.sqrt(len2) * Math.min(t, 1 - t) > frameTolerance
      )
        cuts.add(t);
    }
    const ts = [...cuts].sort((x, y) => x - y);
    const at = (t: number) => [0, 1, 2].map((k) => l.a[k]! + d[k]! * t) as V3;
    const length = Math.sqrt(len2);
    for (let k = 0; k + 1 < ts.length; k++) {
      const [t0, t1] = [ts[k]!, ts[k + 1]!];
      // Up to four elements per piece (the own weight is lumped to their ends), none shorter
      // than twice the merging tolerance, so no two of its nodes fall together.
      const m = Math.max(1, Math.min(4, Math.floor((length * (t1 - t0)) / (2 * frameTolerance))));
      const pts = Array.from({ length: m + 1 }, (_, i) => t0 + ((t1 - t0) * i) / m);
      const nodes = pts.map((t) => nodeAt(at(t)));
      // A piece whose ends fell together (cut close to another line's end) adds nothing.
      if (nodes[0] === nodes[m]) continue;
      pieces.push({ line: l, nodes, ts: pts });
    }
  }
  // Which pieces reach a support: joined through shared nodes.
  const n = coords.length / 3;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]!]!;
    return x;
  };
  for (const p of pieces) for (const q of p.nodes) parent[find(q)] = find(p.nodes[0]!);
  // The supports: the feet of the columns at the foundation level.
  const supports = new Set<number>();
  for (const l of lines)
    if (l.kind === 'column') {
      const low = l.a[2] <= l.b[2] ? l.a : l.b;
      if (Math.abs(low[2] - base) <= frameTolerance) supports.add(nodeAt(low));
    }
  const grounded = new Set([...supports].map(find));
  const kept = pieces.filter((p) => grounded.has(find(p.nodes[0]!)));
  const dropped = [
    ...new Set(pieces.filter((p) => !kept.includes(p)).map((p) => p.line.elementId)),
  ];
  if (dropped.length)
    notes.push({
      code: 'frame-unsupported',
      path: dropped[0]!,
      message: `${dropped.length} member${dropped.length > 1 ? 's reach' : ' reaches'} no support and ${dropped.length > 1 ? 'are' : 'is'} left out: ${dropped.slice(0, 5).join(', ')}${dropped.length > 5 ? ' …' : ''}`,
    });
  // Renumber the kept nodes; group the elements by section, direction and material.
  const used = new Map<number, number>();
  const nodes: number[] = [];
  const keep = (q: number) => {
    let r = used.get(q);
    if (r === undefined) {
      r = nodes.length / 3;
      used.set(q, r);
      nodes.push(coords[3 * q]!, coords[3 * q + 1]!, coords[3 * q + 2]!);
    }
    return r;
  };
  const groups = new Map<string, FrameModel['groups'][number]>();
  const densityOf = new Map<string, number>();
  const membersBy = new Map<string, FrameMember>();
  const groupElements: { group: string; member: FrameMember }[] = [];
  const weightless = new Set<string>();
  for (const p of kept) {
    const l = p.line;
    if (l.weightless) weightless.add(l.elementId);
    let member = membersBy.get(l.elementId);
    if (!member) {
      member = {
        elementId: l.elementId,
        kind: l.kind,
        elements: [],
        nodes: [],
        approximate: l.approximate,
      };
      membersBy.set(l.elementId, member);
    }
    const q = p.nodes.map(keep);
    for (let k = 0; k + 1 < q.length; k++) {
      if (q[k] === q[k + 1]) continue;
      const tm = (p.ts[k]! + p.ts[k + 1]!) / 2;
      const section =
        l.topScale === undefined ? l.section : scaledSection(l.section, 1 + (l.topScale - 1) * tm);
      const key = JSON.stringify([
        section,
        l.dir.map((x) => Math.round(x * 1e6) / 1e6),
        l.materialKey,
      ]);
      if (!groups.has(key)) {
        const m = material.get(l.materialKey)!;
        groups.set(key, {
          section,
          depthDirection: l.dir,
          material: {
            youngsModulus: m.youngsModulusMPa!,
            poissonsRatio: m.poissonsRatio ?? (m.category === 'concrete' ? 0.2 : 0.3),
          },
          elements: [],
        });
        // t/mm³: the own weight is lumped to the element ends below (none known: 0, and said).
        densityOf.set(key, (m.densityKgM3 ?? 0) * 1e-12);
      }
      groups.get(key)!.elements.push(q[k]!, q[k + 1]!);
      groupElements.push({ group: key, member });
    }
    for (const x of q) if (!member.nodes.includes(x)) member.nodes.push(x);
  }
  // Element indices in model order: group by group, as written.
  const order = [...groups.keys()];
  const counters = new Map(order.map((k) => [k, 0]));
  const offsets = new Map<string, number>();
  let off = 0;
  for (const k of order) {
    offsets.set(k, off);
    off += groups.get(k)!.elements.length / 2;
  }
  for (const { group, member } of groupElements) {
    const i = counters.get(group)!;
    counters.set(group, i + 1);
    member.elements.push(offsets.get(group)! + i);
  }
  // Slab loads to the nearest frame node at the slab's level.
  const force = new Map<number, number>();
  const slabLoads: ConstructionFrame['slabLoads'] = [];
  for (const s of slabs) {
    const shape = world.derived.shapes.get(s.elementId);
    if (shape?.kind !== 'slab') {
      notes.push({
        code: 'load-unsupported',
        path: s.elementId,
        message: `${s.elementId} is not a slab`,
      });
      continue;
    }
    // Arcs kept: the area from the loops, the outline sampled along them.
    const poly = sampleLoop(shape.boundary) as [number, number][];
    const area = slabArea(shape);
    // The slab's top over a plan point (a sloped slab rises along its direction).
    const sl = shape.slope;
    const topAt = (x: number, y: number) =>
      sl
        ? shape.zTop +
          sl.grade * ((x - sl.origin[0]) * sl.direction[0] + (y - sl.origin[1]) * sl.direction[1])
        : shape.zTop;
    const candidates: number[] = [];
    for (let q = 0; q < nodes.length / 3; q++)
      if (
        Math.abs(nodes[3 * q + 2]! - topAt(nodes[3 * q]!, nodes[3 * q + 1]!)) <=
          slabLevelTolerance &&
        distanceToPolygon([nodes[3 * q]!, nodes[3 * q + 1]!], poly) <= slabLevelTolerance
      )
        candidates.push(q);
    if (!candidates.length) {
      notes.push({
        code: 'load-unsupported',
        path: s.elementId,
        message: `${s.elementId}: no frame stands under it; its load is left out`,
      });
      continue;
    }
    const total = (s.self + s.site) * area;
    // Sample points over the slab, each to its nearest candidate; the grid made finer until
    // it falls inside a slab narrower than a step.
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    const holes = shape.holes.map((h) => sampleLoop(h) as [number, number][]);
    const share = new Map<number, number>();
    let count = 0;
    for (let step = Math.max(250, Math.sqrt(area / 4000)); !count && step >= 1; step /= 2)
      for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step)
        for (let y = Math.min(...ys) + step / 2; y < Math.max(...ys); y += step) {
          if (!insidePolygon([x, y], poly) || holes.some((h) => insidePolygon([x, y], h))) continue;
          let best = candidates[0]!;
          let bd = Infinity;
          for (const q of candidates) {
            // In space from the slab's top: of nodes one over another, the one at its level.
            const d =
              (nodes[3 * q]! - x) ** 2 +
              (nodes[3 * q + 1]! - y) ** 2 +
              (nodes[3 * q + 2]! - topAt(x, y)) ** 2;
            if (d < bd) [bd, best] = [d, q];
          }
          share.set(best, (share.get(best) ?? 0) + 1);
          count++;
        }
    if (!count) {
      notes.push({
        code: 'load-unsupported',
        path: s.elementId,
        message: `${s.elementId}: the slab has no area to load; its load is left out`,
      });
      continue;
    }
    for (const [q, k] of share) force.set(q, (force.get(q) ?? 0) + (total * k) / count);
    slabLoads.push({ elementId: s.elementId, selfN: s.self * area, siteN: s.site * area });
  }
  if (weightless.size)
    notes.push({
      code: 'mass-unknown',
      path: [...weightless][0]!,
      message: `${weightless.size} member${weightless.size > 1 ? 's have' : ' has'} no density; ${weightless.size > 1 ? 'their' : 'its'} own weight is left out: ${[...weightless].slice(0, 5).join(', ')}${weightless.size > 5 ? ' …' : ''}`,
    });
  const members = [...membersBy.values()];
  if (!members.length)
    return {
      members: [],
      totalLoadN: 0,
      slabLoads,
      notes: [...notes, { code: 'frame-empty', path: '', message: 'no frame stands on a support' }],
    };
  // The members' own weight, half of each element's to each of its ends.
  for (const [key, g] of groups) {
    const w = g.section.area * densityOf.get(key)! * gravity;
    for (let e = 0; e < g.elements.length; e += 2) {
      const [a, b] = [g.elements[e]!, g.elements[e + 1]!];
      const len = Math.hypot(
        nodes[3 * b]! - nodes[3 * a]!,
        nodes[3 * b + 1]! - nodes[3 * a + 1]!,
        nodes[3 * b + 2]! - nodes[3 * a + 2]!,
      );
      for (const q of [a, b]) force.set(q, (force.get(q) ?? 0) + (w * len) / 2);
    }
  }
  const total = [...force.values()].reduce((t, f) => t + f, 0);
  return {
    model: {
      nodes,
      groups: [...groups.values()],
      fixed: [...supports].filter((q) => used.has(q)).map((q) => used.get(q)!),
      force: [...force].sort((x, y) => x[0] - y[0]).map(([q, f]) => [q, 0, 0, -f]),
    },
    members,
    totalLoadN: total,
    slabLoads,
    notes,
  };
}

function insidePolygon(q: [number, number], p: readonly [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i]!;
    const [xj, yj] = p[j]!;
    if (yi > q[1] !== yj > q[1] && q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}
function distanceToPolygon(q: [number, number], p: readonly [number, number][]): number {
  if (insidePolygon(q, p)) return 0;
  let best = Infinity;
  for (let i = 0; i < p.length; i++) {
    const [ax, ay] = p[i]!;
    const [bx, by] = p[(i + 1) % p.length]!;
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(
      0,
      Math.min(1, ((q[0] - ax) * dx + (q[1] - ay) * dy) / (dx * dx + dy * dy || 1)),
    );
    best = Math.min(best, Math.hypot(q[0] - ax - dx * t, q[1] - ay - dy * t));
  }
  return best;
}

/** A slab's plan area (mm²), its arcs kept, less its holes. */
function slabArea(shape: { boundary: BimLoop; holes: readonly BimLoop[] }): number {
  return (
    Math.abs(loopArea(shape.boundary)) - shape.holes.reduce((t, h) => t + Math.abs(loopArea(h)), 0)
  );
}

/** A slab's own weight as N/mm², or why it is not known. */
function slabSelf(world: FrameWorld, id: string): number | string {
  const m = bimElementMass(world.bim, world.derived, id, world.kernelQuantities);
  if (m.status !== 'ok') return m.status;
  const shape = world.derived.shapes.get(id);
  if (shape?.kind !== 'slab') return 'unsupported';
  const area = slabArea(shape);
  return area > 0 ? (m.kg * gravity * 1e-3) / area : 'unsupported';
}

/**
 * The frame standing on `day`: built (or existing, or being removed) members, temporary ones
 * while their task runs, and members being built that a lift has set by that day; the slabs standing or being cast carry their weight, and
 * the site loads of the tasks running carry theirs.
 */
export function frameOnDay(
  doc: ConstructionDocument,
  schedule: ConstructionSchedule,
  world: FrameWorld,
  day: string,
): ConstructionFrame {
  const states = siteOnDay(doc, schedule, day).states;
  const times = liftTimes(doc, schedule);
  const setBy = new Map<string, string>();
  for (const l of doc.site?.lifts ?? []) {
    const t = times.get(l.id);
    if (t) setBy.set(l.elementId, t.day);
  }
  const stands = (id: string) => {
    const s = states.get(id) ?? 'existing';
    // Temporary works (shoring, a temporary beam) stand while their task runs.
    if (s === 'built' || s === 'existing' || s === 'removing' || s === 'temporary') return true;
    if (s === 'building') return (setBy.get(id) ?? '￿') <= day;
    return false;
  };
  const site = new Map<string, number>();
  for (const load of doc.site?.loads ?? []) {
    const task = doc.tasks.find((t) => t.id === load.taskId);
    const planned = schedule.byId.get(load.taskId);
    if (!task || !planned || taskPhase(task, planned, day) !== 'running') continue;
    for (const id of load.elementIds) site.set(id, (site.get(id) ?? 0) + load.kNm2 * 1e-3);
  }
  const loaded = (id: string) => {
    const s = states.get(id) ?? 'existing';
    return (
      s === 'built' || s === 'existing' || s === 'removing' || s === 'building' || s === 'temporary'
    );
  };
  return slabFrame(world, stands, loaded, site);
}

/** The completed building: every member and slab that is built (not removed, not temporary). */
export function frameCompleted(
  doc: ConstructionDocument,
  schedule: ConstructionSchedule,
  world: FrameWorld,
): ConstructionFrame {
  const states = siteOnDay(doc, schedule, '9999-12-31').states;
  const stands = (id: string) => {
    const s = states.get(id) ?? 'existing';
    return s === 'built' || s === 'existing';
  };
  return slabFrame(world, stands, stands, new Map());
}

function slabFrame(
  world: FrameWorld,
  stands: (id: string) => boolean,
  loaded: (id: string) => boolean,
  site: ReadonlyMap<string, number>,
): ConstructionFrame {
  const slabs: SlabLoad[] = [];
  const notes: ConstructionDiagnostic[] = [];
  for (const [id, s] of world.derived.shapes) {
    if (s.kind !== 'slab') continue;
    const extra = site.get(id) ?? 0;
    if (!loaded(id)) {
      if (extra)
        notes.push({
          code: 'load-unsupported',
          path: id,
          message: `${id}: the site load lies on a slab that does not stand; it is left out`,
        });
      continue;
    }
    const self = slabSelf(world, id);
    if (typeof self === 'string')
      notes.push({
        code: 'mass-unknown',
        path: id,
        message: `${id}: the slab's weight is not known (${self})`,
      });
    slabs.push({ elementId: id, self: typeof self === 'number' ? self : 0, site: extra });
  }
  for (const id of site.keys())
    if (world.derived.shapes.get(id)?.kind !== 'slab')
      notes.push({ code: 'load-unsupported', path: id, message: `${id} is not a slab` });
  const frame = buildFrame(world, stands, slabs);
  return { ...frame, notes: [...notes, ...frame.notes] };
}

// ---------------------------------------------------------------------------------------------
// Results

export interface FrameMemberResult {
  elementId: string;
  kind: FrameMember['kind'];
  /** The largest |normal stress along the axis| (MPa). */
  stressMPa: number;
  /** The largest displacement of its nodes (mm). */
  displacementMm: number;
  approximate: boolean;
}

/** Per member, from a frame result (displacement per node, stress per element). */
export function frameMemberResults(
  frame: ConstructionFrame,
  result: { displacement: ArrayLike<number>; stress: ArrayLike<number> },
): FrameMemberResult[] {
  return frame.members.map((m) => ({
    elementId: m.elementId,
    kind: m.kind,
    stressMPa: Math.max(0, ...m.elements.map((e) => result.stress[e]!)),
    displacementMm: Math.max(
      0,
      ...m.nodes.map((q) =>
        Math.hypot(
          result.displacement[3 * q]!,
          result.displacement[3 * q + 1]!,
          result.displacement[3 * q + 2]!,
        ),
      ),
    ),
    approximate: m.approximate,
  }));
}

export interface FrameComparison {
  elementId: string;
  dayMPa: number;
  completedMPa: number;
  /** Day over completed; Infinity when the completed stress is 0. */
  ratio: number;
}

/** Members of the day's frame against the completed building, the day's worst ratio first. */
export function compareFrames(
  day: readonly FrameMemberResult[],
  completed: readonly FrameMemberResult[],
): FrameComparison[] {
  const done = new Map(completed.map((r) => [r.elementId, r.stressMPa]));
  return day
    .filter((r) => done.has(r.elementId))
    .map((r) => {
      const c = done.get(r.elementId)!;
      return {
        elementId: r.elementId,
        dayMPa: r.stressMPa,
        completedMPa: c,
        ratio: c > 0 ? r.stressMPa / c : r.stressMPa > 0 ? Infinity : 1,
      };
    })
    .sort((a, b) => b.ratio - a.ratio || b.dayMPa - a.dayMPa);
}

// ---------------------------------------------------------------------------------------------
// Crane foundations

export interface CraneReaction {
  craneId: string;
  /** The crane's own weight and the heaviest load (kN). */
  verticalKN: number;
  /** The largest load × radius about the mast (kN·m). */
  momentKNm: number;
  /** The lift that gives the moment, and its day. */
  liftId?: string;
  day?: string;
  /** Lifts whose mass is not known (left out). */
  unknown: number;
  /** The crane's own mass was not given: the reaction is the load's only. */
  ownMassKnown: boolean;
}

/**
 * Each crane's foundation reaction from its lifts (on `day` only, when given): the vertical load
 * of the crane's own mass and the heaviest load, and the largest overturning moment of a load at
 * its radius (the farther of the pick and the place). On a day, the cranes not standing then are
 * left out. Lifts out of reach are left to `checkCranes`.
 */
export function craneReactions(
  doc: ConstructionDocument,
  schedule: ConstructionSchedule,
  world: CraneWorld,
  day?: string,
): CraneReaction[] {
  const times = liftTimes(doc, schedule);
  // On a day, only the cranes standing then.
  const cranes = (doc.site?.cranes ?? []).filter(
    (c) => day === undefined || craneStands(doc, schedule, c, day),
  );
  return cranes.map((c) => {
    let heaviest = 0;
    let moment = 0;
    let liftId: string | undefined;
    let at: string | undefined;
    let unknown = 0;
    for (const l of doc.site?.lifts ?? []) {
      if (l.craneId !== c.id) continue;
      const t = times.get(l.id);
      if (!t || (day !== undefined && t.day !== day)) continue;
      const m = world.mass(l.elementId);
      if ('reason' in m) {
        unknown++;
        continue;
      }
      const body = world.bodies.get(l.elementId);
      const place: Point3 | undefined = body && [
        (body.bounds[0][0] + body.bounds[1][0]) / 2,
        (body.bounds[0][1] + body.bounds[1][1]) / 2,
        body.bounds[0][2],
      ];
      const r = Math.max(
        Math.hypot(l.pick[0] - c.base[0], l.pick[1] - c.base[1]),
        place ? Math.hypot(place[0] - c.base[0], place[1] - c.base[1]) : 0,
      );
      heaviest = Math.max(heaviest, m.kg);
      const mm = m.kg * r;
      if (mm > moment) [moment, liftId, at] = [mm, l.id, t.day];
    }
    const g = gravity / 1000; // m/s²
    return {
      craneId: c.id,
      verticalKN: (((c.massKg ?? 0) + heaviest) * g) / 1000,
      momentKNm: (moment * g) / 1e6,
      ...(liftId ? { liftId, day: at } : {}),
      unknown,
      ownMassKnown: c.massKg !== undefined,
    };
  });
}
