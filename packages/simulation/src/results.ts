/**
 * R3e-4c/4d: a result for display and export (docs/cad/r3-analysis.md, 結果表示と形式). A result
 * source is a run's finest mesh or a VTU read for display; it is shown as its boundary moved by
 * the displacement times a scale and coloured by a nodal scalar, optionally cut by an axis plane
 * whose cut faces carry the colour map too, and read at a point. Display only: nothing here is
 * stored; the VTU export writes a run's mesh with every nodal field.
 */
import type { CadMesh } from '@editor-platform/cad-kernel-occt';
import {
  localFaces,
  nodesPerElement,
  principalStresses,
  readVtu,
  tet10Edges,
  writeVtu,
  type FemMesh,
  type VtuResult,
} from '@editor-platform/geometry-fem';
import type { AeroFlowField, AeroRunFields } from './aero-view';
import type { RunFields } from './run';
import { sealRibbonMesh, type SealRunFields } from './run-seal';
import type { ShowerRunFields } from './run-shower';

/** One nodal scalar a result can be coloured by. */
export interface ResultScalar {
  id: string;
  label: string;
  unit: string;
  values: Float64Array;
  /** R3g: the shape this field moves the mesh by (a mode's), instead of the result's displacement. */
  displacement?: Float64Array;
  /** VS7c: triangles not shown with this field (1 each: a crash frame's erased shells). */
  hidden?: Uint8Array;
  /**
   * VS11d-2: the colour range of fields shown one after another (a transient run's times share
   * one, so a colour means the same temperature at every time); without it, the field's own.
   */
  range?: [number, number];
  /**
   * A field of kinds rather than amounts: value k (rounded) is class k, drawn in its own colour
   * and named in the legend, whatever the colour range.
   */
  classes?: readonly ResultClass[];
}
/** VS11d-2: a transient run's times, the field of each, and the history of every step. */
export interface ResultTimeline {
  /** s, of each kept field. */
  times: number[];
  /** The scalar id of each kept time's field. */
  fields: string[];
  /** Every step: its time (s) and the highest and lowest temperature (K). */
  history: { time: ArrayLike<number>; max: ArrayLike<number>; min: ArrayLike<number> };
}
/** One kind a class field names (`ResultScalar.classes`), with its colour (0–1 rgb). */
export interface ResultClass {
  label: string;
  color: readonly [number, number, number];
}
/** What a result shows: the mesh's corners, its outward boundary, its fields. */
export interface ResultSource {
  /** Where it came from, for the panel ("Run", or the VTU's file name). */
  origin: string;
  nodes: Float64Array;
  /**
   * Linear tets for sections, four nodes each: a tet4 as it is, a tet10 as its eight sub-tets
   * through the mid-edge nodes, so a cut meets the boundary's sub-triangles and shows mid-edge
   * values.
   */
  tets: Uint32Array;
  /**
   * Outward triangles of the boundary, three node indices each: a tet4 face as it is, a tet10
   * face as four sub-triangles through its mid-edge nodes.
   */
  triangles: Uint32Array;
  /** x, y, z per node (mm), when the result has one. */
  displacement?: Float64Array;
  /**
   * R3j-6c: 1 for each triangle of a shell's midsurface, seen from both sides; without it, every
   * triangle of a result with no tets is.
   */
  twoSided?: Uint8Array;
  scalars: ResultScalar[];
  /** VS4c: a wind tunnel's bodies (nothing moves them); a browser run's flow, for streamlines and a section of its speed. */
  aero?: { flow?: AeroFlowField };
  /**
   * VS7c-2: a crash run's frames: shown at their true size (the auto deformation scale is 1),
   * and every frame coloured over one range (the largest plastic strain of the run), so its video
   * does not rescale from frame to frame.
   */
  crash?: { range: [number, number] };
  /** VS11d-2: a transient run's timeline. */
  transient?: ResultTimeline;
}

const magnitude = (v: Float64Array) => {
  const out = new Float64Array(v.length / 3);
  for (let i = 0; i < out.length; i++) out[i] = Math.hypot(v[i * 3]!, v[i * 3 + 1]!, v[i * 3 + 2]!);
  return out;
};
const corners = (type: FemMesh['type'], elements: Uint32Array) => {
  const npe = nodesPerElement(type);
  const n = elements.length / npe;
  const out = new Uint32Array(n * 4);
  for (let e = 0; e < n; e++) for (let c = 0; c < 4; c++) out[e * 4 + c] = elements[e * npe + c]!;
  return out;
};

/** Mid-edge node (tet10 local index) between two corners. */
const midNode = (i: number, j: number) =>
  4 + tet10Edges.findIndex(([a, b]) => (a === i && b === j) || (a === j && b === i));

/**
 * The display triangles of local face `face` of element `e`: its corners for tet4, and for tet10
 * its four sub-triangles through the mid-edge nodes, so the display follows the quadratic surface
 * that was solved and every boundary node takes part in the range.
 */
function faceTriangles(type: FemMesh['type'], elements: Uint32Array, e: number, face: number) {
  const npe = nodesPerElement(type);
  const node = (local: number) => elements[e * npe + local]!;
  const [a, b, c] = localFaces[face]!;
  if (type !== 'tet10') return [node(a), node(b), node(c)];
  const [ab, bc, ca] = [midNode(a, b), midNode(b, c), midNode(c, a)].map(node) as [
    number,
    number,
    number,
  ];
  const [A, B, C] = [node(a), node(b), node(c)];
  return [A, ab, ca, ab, B, bc, ca, bc, C, ab, bc, ca];
}

/** Eight linear sub-tets of each tet10 (four at the corners, four in the inner octahedron). */
const tet10Split = (() => {
  const m = (i: number, j: number) => midNode(i, j);
  return [
    [0, m(0, 1), m(0, 2), m(0, 3)],
    [m(0, 1), 1, m(1, 2), m(1, 3)],
    [m(0, 2), m(1, 2), 2, m(2, 3)],
    [m(0, 3), m(1, 3), m(2, 3), 3],
    [m(0, 1), m(0, 2), m(0, 3), m(1, 3)],
    [m(0, 1), m(0, 2), m(1, 2), m(1, 3)],
    [m(0, 2), m(0, 3), m(1, 3), m(2, 3)],
    [m(0, 2), m(1, 2), m(1, 3), m(2, 3)],
  ];
})();
const linearTets = (type: FemMesh['type'], elements: Uint32Array) => {
  if (type !== 'tet10') return corners(type, elements);
  const n = elements.length / 10;
  const out = new Uint32Array(n * 32);
  for (let e = 0; e < n; e++)
    tet10Split.forEach((t, k) =>
      t.forEach((l, c) => (out[e * 32 + k * 4 + c] = elements[e * 10 + l]!)),
    );
  return out;
};

/** The x, y, z (or with `at` 3, the rotations) of each node of a field with 6 DOFs per node. */
const translations = (v: Float64Array, at: 0 | 3 = 0) => {
  const out = new Float64Array(v.length / 2);
  for (let p = 0; p < out.length / 3; p++)
    for (let i = 0; i < 3; i++) out[3 * p + i] = v[6 * p + at + i]!;
  return out;
};
/** A mode shape as a field: scaled to a largest movement of 1, coloured by its size. */
const modeScalars = (modes: { frequency: number; shape: Float64Array }[]) =>
  modes.map((m, k): ResultScalar => {
    const size = magnitude(m.shape);
    const max = size.reduce((a, b) => Math.max(a, b), 0);
    const shape = max > 0 ? m.shape.map((v) => v / max) : m.shape;
    return {
      id: `mode-${k + 1}`,
      label: `Mode ${k + 1} at ${modeFrequency(m.frequency)} Hz`,
      unit: '',
      values: max > 0 ? size.map((v) => v / max) : size,
      displacement: shape,
    };
  });

/**
 * R3i-4: a shell run's midsurface, its triangles shown as they are (no sections: `tets` is
 * empty). Static: von Mises on the larger of the two surfaces, on the top (+t/2 along the
 * normal) and the bottom, and the displacement; modal: each mode's translations.
 */
function shellResult(fields: Extract<RunFields, { kind: 'shell-static' | 'shell-modal' }>) {
  const base = {
    origin: 'Run',
    nodes: fields.mesh.nodes,
    tets: new Uint32Array(0),
    triangles: fields.mesh.triangles,
  };
  if (fields.kind === 'shell-modal') {
    const scalars = modeScalars(
      fields.modes.map((m) => ({ frequency: m.frequency, shape: translations(m.shape) })),
    );
    return { ...base, displacement: scalars[0]?.displacement, scalars };
  }
  const displacement = translations(fields.displacement);
  return {
    ...base,
    displacement,
    scalars: [
      { id: 'von-mises', label: 'von Mises stress', unit: 'MPa', values: fields.vonMises.max },
      {
        id: 'von-mises-top',
        label: 'von Mises stress, top',
        unit: 'MPa',
        values: fields.vonMises.top,
      },
      {
        id: 'von-mises-bottom',
        label: 'von Mises stress, bottom',
        unit: 'MPa',
        values: fields.vonMises.bottom,
      },
      { id: 'displacement', label: 'Displacement', unit: 'mm', values: magnitude(displacement) },
    ],
  };
}

type BondedFields = Extract<RunFields, { kind: 'bonded-static' | 'bonded-modal' }>;

/**
 * R3j-6c: how each body of a bonded run was solved, the source body first: a solid, or a shell
 * with its thickness (mm; the smallest and largest of its triangles, equal for one wall).
 */
export function bondedBodies(fields: RunFields) {
  if (fields.kind !== 'bonded-static' && fields.kind !== 'bonded-modal') return undefined;
  return fields.bodies.map(({ bodyId, fields: f }) => {
    if (f.kind !== 'shell-static' && f.kind !== 'shell-modal')
      return { bodyId, kind: 'solid' as const };
    const t = f.mesh.thickness;
    let min = Infinity,
      max = -Infinity;
    for (const x of t) [min, max] = [Math.min(min, x), Math.max(max, x)];
    return { bodyId, kind: 'shell' as const, thickness: [min, max] as [number, number] };
  });
}

/**
 * R3j-6c: every body of a bonded run as one result: the meshes side by side, the fields every
 * body has (von Mises and the displacement; each mode), and each mode scaled to a largest
 * movement of 1 over all bodies, so the bodies move together.
 */
function bondedResult(fields: BondedFields): ResultSource {
  const parts = fields.bodies.map((b) => runResult(b.fields));
  const offsets: number[] = [];
  let count = 0;
  for (const p of parts) {
    offsets.push(count);
    count += p.nodes.length / 3;
  }
  const join = (pick: (p: ResultSource, i: number) => ArrayLike<number>, shift: boolean) => {
    const out = new (shift ? Uint32Array : Float64Array)(
      parts.reduce((n, p, i) => n + pick(p, i).length, 0),
    );
    let at = 0;
    parts.forEach((p, i) => {
      const v = pick(p, i);
      for (let k = 0; k < v.length; k++) out[at++] = shift ? v[k]! + offsets[i]! : v[k]!;
    });
    return out;
  };
  const base = {
    origin: 'Run',
    nodes: join((p) => p.nodes, false) as Float64Array,
    tets: join((p) => p.tets, true) as Uint32Array,
    triangles: join((p) => p.triangles, true) as Uint32Array,
    // A shell body's triangles are seen from both sides, a solid's boundary from outside.
    twoSided: Uint8Array.from(
      parts.flatMap((p) =>
        Array.from({ length: p.triangles.length / 3 }, () => (p.tets.length === 0 ? 1 : 0)),
      ),
    ),
  };
  if (fields.kind === 'bonded-modal') {
    // Each body's mode shapes as solved (translations), joined, then scaled together.
    const shapes = fields.bodies.map(({ fields: f }) =>
      f.kind === 'shell-modal'
        ? f.modes.map((m) => translations(m.shape))
        : f.modes.map((m) => m.shape),
    );
    const modes = fields.bodies[0]!.fields.modes.map((m, k) => ({
      frequency: m.frequency,
      shape: join((_, i) => shapes[i]![k]!, false) as Float64Array,
    }));
    const scalars = modeScalars(modes);
    return { ...base, displacement: scalars[0]?.displacement, scalars };
  }
  const ids = parts[0]!.scalars
    .map((s) => s.id)
    .filter((id) => parts.every((p) => p.scalars.some((s) => s.id === id)));
  return {
    ...base,
    displacement: join((p) => p.displacement!, false) as Float64Array,
    scalars: ids.map((id) => {
      const first = parts[0]!.scalars.find((s) => s.id === id)!;
      return {
        id,
        label: first.label,
        unit: first.unit,
        values: join((p) => p.scalars.find((s) => s.id === id)!.values, false) as Float64Array,
      };
    }),
  };
}

/** A run's finest level: von Mises, the principal stresses and the displacement's magnitude. */
/** VS4c: a wind-tunnel run's bodies, coloured by Cp (and on the Host by Cf and h). */
function aeroResult(fields: AeroRunFields): ResultSource {
  const scalars: ResultScalar[] = [
    { id: 'cp', label: 'Pressure coefficient Cp', unit: '', values: fields.cp },
  ];
  if (fields.cf)
    scalars.push({ id: 'cf', label: 'Skin friction coefficient Cf', unit: '', values: fields.cf });
  if (fields.htc)
    scalars.push({
      id: 'htc',
      label: 'Heat transfer coefficient',
      unit: 'W/(m²·K)',
      values: fields.htc,
    });
  return {
    origin: 'Run',
    nodes: fields.points,
    tets: new Uint32Array(0),
    triangles: fields.triangles,
    // A closed outside, seen from outside only.
    twoSided: new Uint8Array(fields.triangles.length / 3),
    scalars,
    aero: fields.flow ? { flow: fields.flow } : {},
  };
}

/**
 * VS7c: a crash run's midsurfaces of all bodies (both sides shown). Each frame is a field of its
 * own, the largest plastic strain through the thickness on each node's triangles, moved by that
 * frame's displacement (scale 1): stepping through them plays the crash. The last frame first.
 */
export function crashResult(fields: Extract<RunFields, { kind: 'crash' }>): ResultSource {
  const n = fields.nodes.length / 3;
  const t = fields.triangles;
  const scalars = fields.frames.map((f, k): ResultScalar => {
    const values = new Float64Array(n);
    for (let e = 0; e < t.length / 3; e++) {
      const p = f.erased[e] ? 0 : f.plasticStrain[e]!;
      for (let c = 0; c < 3; c++) {
        const i = t[3 * e + c]!;
        if (p > values[i]!) values[i] = p;
      }
    }
    return {
      id: `frame-${k}`,
      label: `Plastic strain at ${(f.time * 1000).toFixed(1)} ms`,
      unit: '',
      values,
      displacement: Float64Array.from(f.displacement),
      // The shells erased by then are gone from the frame (a torn sheet shows its tear).
      ...(f.erased.some((x) => x) ? { hidden: Uint8Array.from(f.erased) } : {}),
    };
  });
  scalars.reverse();
  let top = 0;
  for (const s of scalars) for (const v of s.values) if (v > top) top = v;
  return {
    origin: 'Run',
    crash: { range: [0, top > 0 ? top : 1] },
    nodes: fields.nodes,
    tets: new Uint32Array(0),
    triangles: t,
    twoSided: new Uint8Array(t.length / 3).fill(1),
    displacement: scalars[0]?.displacement,
    scalars,
  };
}

/**
 * VS9b: a seal run's seals as ribbons (each point from the base face up to the closure, or the
 * free height where it does not touch), coloured by compression, gap or leak.
 */
function sealResult(fields: SealRunFields): ResultSource {
  const r = sealRibbonMesh(fields);
  return {
    origin: 'Run',
    nodes: r.nodes,
    tets: new Uint32Array(0),
    triangles: r.triangles,
    scalars: [
      { id: 'compression', label: 'Seal compression', unit: '%', values: r.compression },
      { id: 'gap', label: 'Gap past the seal', unit: 'mm', values: r.gap },
      { id: 'leak', label: 'Leak (1)', unit: '', values: r.leak },
    ],
  };
}

/** The share of the bodies' box diagonal a shower's particle and entry marks span each way. */
export const showerMarkScale = Object.freeze({ particle: 0.003, entry: 0.01 });
const octahedronFaces = [
  [0, 2, 4],
  [2, 1, 4],
  [1, 3, 4],
  [3, 0, 4],
  [2, 0, 5],
  [1, 2, 5],
  [3, 1, 5],
  [0, 3, 5],
] as const;
const boxDiagonal = (points: ArrayLike<number>) => {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < points.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, points[i + k]!);
      hi[k] = Math.max(hi[k]!, points[i + k]!);
    }
  return points.length >= 3 ? Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) : 0;
};
/**
 * The colour of each kind in a shower's water field, apart at a glance: grey body, green seal,
 * red leak, light blue drop, deep blue film, violet pond and magenta where it went in.
 */
export const showerWaterColors: readonly (readonly [number, number, number])[] = Object.freeze([
  [0.6, 0.64, 0.69],
  [0.15, 0.6, 0.3],
  [0.9, 0.12, 0.1],
  [0.45, 0.78, 1.0],
  [0.05, 0.3, 0.85],
  [0.55, 0.25, 0.85],
  [0.95, 0.1, 0.75],
] as const);

/** VS10b: what each value of a shower's water field means. */
export const showerWaterLabels = Object.freeze([
  'body',
  'seal',
  'leaking seal',
  'drop',
  'film',
  'ponding',
  'went in',
] as const);

/**
 * VS10b: a shower run as one triangle mesh with a "water" value per node (`showerWaterLabels`):
 * the bodies as the water met them, the seals' ribbons, each particle of frame `frame` (the last
 * by default) as a small mark and each place the water went in as a larger one.
 */
export function showerMesh(
  fields: ShowerRunFields,
  frame = fields.frames.length - 1,
  surface = true,
) {
  const nodes: number[] = [];
  const triangles: number[] = [];
  const water: number[] = [];
  const s = fields.surface;
  if (surface) {
    // Element by element: a large body is past the arguments a spread can pass (Codex on #1271).
    for (const v of s.points) nodes.push(v);
    for (const t of s.triangles) triangles.push(t);
    for (let k = 0; k < s.points.length / 3; k++) water.push(0);
  } else {
    // The bodies are drawn beside the result (`showerBodies`); two empty triangles at the corners
    // of their box keep the view's fit on them whatever the water does.
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < s.points.length; i += 3)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, s.points[i + k]!);
        hi[k] = Math.max(hi[k]!, s.points[i + k]!);
      }
    if (s.points.length) {
      nodes.push(...lo, ...lo, ...lo, ...hi, ...hi, ...hi);
      triangles.push(0, 1, 2, 3, 4, 5);
      water.push(0, 0, 0, 0, 0, 0);
    }
  }
  const ribbon = sealRibbonMesh({ kind: 'seal', seals: fields.seals });
  const first = nodes.length / 3;
  for (const v of ribbon.nodes) nodes.push(v);
  for (const t of ribbon.triangles) triangles.push(first + t);
  for (const l of ribbon.leak) water.push(l ? 2 : 1);
  // Marks sized from the bodies' box, so they show at a car's scale as at a test plate's: a
  // particle reaches 0.3 % of its diagonal each way (at least 4 mm), an entry 1 % (at least 15 mm).
  const size = boxDiagonal(s.points);
  const dropH = Math.max(4, size * showerMarkScale.particle);
  const entryH = Math.max(15, size * showerMarkScale.entry);
  /** A small octahedron round p, half-size h: seen from any side, unlike flat marks. */
  const mark = (p: readonly number[], h: number, value: number) => {
    const b = nodes.length / 3;
    const [x, y, z] = p as [number, number, number];
    nodes.push(x + h, y, z, x - h, y, z, x, y + h, z, x, y - h, z, x, y, z + h, x, y, z - h);
    // Outward, counter-clockwise from outside.
    for (const [i, j, k] of octahedronFaces) triangles.push(b + i, b + j, b + k);
    for (let k = 0; k < 6; k++) water.push(value);
  };
  const f = fields.frames[frame];
  if (f)
    for (let i = 0; i < f.states.length; i++) {
      // drop 0 → 3, film 1 → 4, pond 2 → 5, entered 3 → 6; drained ones are not drawn. One that
      // has gone in by this frame is drawn large where it went in, so an early frame shows no
      // entry yet (Codex on #1271).
      if (f.states[i] === 4) continue;
      const p = [f.positions[3 * i]!, f.positions[3 * i + 1]!, f.positions[3 * i + 2]!];
      mark(p, f.states[i] === 3 ? entryH : dropH, 3 + f.states[i]!);
    }
  else for (const e of fields.entries) mark(e.position, entryH, 6);
  return {
    nodes: new Float64Array(nodes),
    triangles: new Uint32Array(triangles),
    water: new Float64Array(water),
  };
}

function showerResult(fields: ShowerRunFields, frame?: number): ResultSource {
  const m = showerMesh(fields, frame, false);
  return {
    origin: 'Run',
    nodes: m.nodes,
    tets: new Uint32Array(0),
    triangles: m.triangles,
    twoSided: new Uint8Array(m.triangles.length / 3).fill(1),
    scalars: [
      {
        id: 'water',
        label: `Water (${showerWaterLabels.map((l, k) => `${k} ${l}`).join(', ')})`,
        unit: '',
        values: m.water,
        classes: showerWaterLabels.map((label, k) => ({ label, color: showerWaterColors[k]! })),
      },
    ],
  };
}

export function runResult(fields: RunFields, bodyId?: string, frame?: number): ResultSource {
  if (fields.kind === 'aero') return aeroResult(fields);
  if (fields.kind === 'seal') return sealResult(fields);
  if (fields.kind === 'shower') return showerResult(fields, frame);
  if (fields.kind === 'crash') return crashResult(fields);
  // R3j-6c: one body of a bonded run, or every body together.
  if (fields.kind === 'bonded-static' || fields.kind === 'bonded-modal') {
    const one = fields.bodies.find((b) => b.bodyId === bodyId);
    return one ? runResult(one.fields) : bondedResult(fields);
  }
  if (fields.kind === 'shell-static' || fields.kind === 'shell-modal') return shellResult(fields);
  const { mesh } = fields;
  const triangles: number[] = [];
  for (let f = 0; f < mesh.boundary.elements.length; f++)
    triangles.push(
      ...faceTriangles(
        mesh.type,
        mesh.elements,
        mesh.boundary.elements[f]!,
        mesh.boundary.localFaces[f]!,
      ),
    );
  const base = {
    origin: 'Run',
    nodes: mesh.nodes,
    tets: linearTets(mesh.type, mesh.elements),
    triangles: new Uint32Array(triangles),
  };
  if (fields.kind === 'modal') {
    // Each mode is a field: its shape scaled to a largest movement of 1, coloured by its size.
    const scalars = modeScalars(fields.modes);
    return { ...base, displacement: scalars[0]?.displacement, scalars };
  }
  // VS11d: each kept time's temperature is a field (the last first), the last flux, and with
  // thermal stress the stress of the last field on its displacement.
  if (fields.kind === 'transient-thermal') {
    const k = fields.times.length - 1;
    const times = [k, ...Array.from({ length: k }, (_, i) => i)];
    let lo = Infinity,
      hi = -Infinity;
    for (const T of fields.temperatures)
      for (const v of T) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    const range: [number, number] = hi > lo ? [lo, hi] : [lo - 0.5, hi + 0.5];
    const labels = transientTimeLabels(fields.times);
    return {
      ...base,
      ...(fields.stress ? { displacement: fields.stress.displacement } : {}),
      transient: {
        times: fields.times,
        fields: fields.times.map((_, i) => `temperature-${i}`),
        history: {
          time: fields.history.time,
          max: fields.history.maxTemperature,
          min: fields.history.minTemperature,
        },
      },
      scalars: [
        ...times.map((i) => ({
          id: `temperature-${i}`,
          label: `Temperature at ${labels[i]!}`,
          unit: 'K',
          values: fields.temperatures[i]!,
          range,
        })),
        {
          id: 'heat-flux',
          label: 'Heat flux at the end',
          unit: 'kW/m²',
          values: fields.fluxMagnitude,
        },
        ...(fields.stress
          ? [
              {
                id: 'von-mises',
                label: 'Thermal von Mises stress',
                unit: 'MPa',
                values: fields.stress.vonMises,
              },
            ]
          : []),
      ],
    };
  }
  // R3h: a thermal run moves nothing; mW/mm² is kW/m².
  if (fields.kind === 'thermal')
    return {
      ...base,
      scalars: [
        { id: 'temperature', label: 'Temperature', unit: 'K', values: fields.temperature },
        { id: 'heat-flux', label: 'Heat flux', unit: 'kW/m²', values: fields.fluxMagnitude },
      ],
    };
  const principal = principalStresses(fields.stress);
  return {
    ...base,
    displacement: fields.displacement,
    scalars: [
      { id: 'von-mises', label: 'von Mises stress', unit: 'MPa', values: fields.vonMises },
      {
        id: 'max-principal',
        label: 'Max principal stress',
        unit: 'MPa',
        values: principal.max,
      },
      {
        id: 'min-principal',
        label: 'Min principal stress',
        unit: 'MPa',
        values: principal.min,
      },
      {
        id: 'displacement',
        label: 'Displacement',
        unit: 'mm',
        values: magnitude(fields.displacement),
      },
      ...(fields.fatigue
        ? [
            {
              id: 'fatigue-life',
              label: 'Fatigue life (log₁₀ passes)',
              unit: '',
              values: fatigueLogLife(fields.fatigue.life),
            },
            {
              id: 'fatigue-damage',
              label: 'Fatigue damage per pass',
              unit: '',
              values: fatigueDamageShown(fields.fatigue.damage),
            },
          ]
        : []),
    ],
  };
}

/** VS13: life is shown as log₁₀ passes, an infinite one (no damage) at this cap. */
export const fatigueLifeCap = 15;
export function fatigueLogLife(life: Float64Array): Float64Array {
  return life.map((l) => (l > 0 ? Math.min(Math.log10(l), fatigueLifeCap) : -fatigueLifeCap));
}

/**
 * VS13: damage per pass as shown and written: a cycle with its mean at the tensile strength fails
 * at once (infinite damage), shown at 10^`fatigueLifeCap` so a VTU takes it (Codex on #1283).
 */
export function fatigueDamageShown(damage: Float64Array): Float64Array {
  const top = 10 ** fatigueLifeCap;
  return damage.map((d) => Math.min(d, top));
}

/** VS11d: a time as the result names it: seconds to four significant digits. */
export const transientTime = (t: number) =>
  `${t >= 1e4 || (t < 1e-2 && t > 0) ? t.toExponential(3).replace('e+', 'e') : Number(t.toPrecision(4))} s`;
/**
 * VS11d (Codex on #1264): the kept times' names, each different (a VTU refuses a field name twice):
 * four digits, or twelve where two would meet (a last step just after a kept time), or the index.
 */
export function transientTimeLabels(times: readonly number[]): string[] {
  const seen = new Set<string>();
  return times.map((t, i) => {
    let label = transientTime(t);
    if (seen.has(label)) label = `${Number(t.toPrecision(12))} s`;
    if (seen.has(label)) label = `${label} (${i + 1})`;
    seen.add(label);
    return label;
  });
}

/** A frequency as the result names it: four significant digits, no `+` (VTU names refuse it). */
export const modeFrequency = (f: number) =>
  f >= 1e4 || f < 1e-2 ? f.toExponential(3).replace('e+', 'e') : f.toPrecision(4);

/** `name (unit)` as this module writes it, else the whole name and no unit. */
const named = (name: string) => {
  const m = /^(.*) \(([^()]*)\)$/.exec(name);
  return m ? { label: m[1]!, unit: m[2]! } : { label: name, unit: '' };
};

/**
 * A VTU for display (R3e: 取り込みは表示だけ). The boundary is every element face no other
 * element shares, wound outward. Every scalar point field is offered, and every vector one by its
 * magnitude; a vector named "Displacement…" moves the shape. Cell fields are not shown.
 * `readVtu`'s checks apply (`result-invalid`); a boundary face shared by more than two elements
 * is refused as not a solid mesh.
 */
export function vtuResult(text: string, origin: string): ResultSource {
  const v: VtuResult = readVtu(text);
  // R3i-5: a shell's triangles are its surface; a solid's is the faces of one element only.
  const cornerTets = v.type === 'tri3' ? new Uint32Array(0) : corners(v.type, v.elements);
  const faces = new Map<string, { e: number; face: number; count: number }>();
  for (let e = 0; e < cornerTets.length / 4; e++)
    localFaces.forEach((f, face) => {
      const key = f
        .map((c) => cornerTets[e * 4 + c]!)
        .sort((a, b) => a - b)
        .join();
      const hit = faces.get(key);
      if (hit) hit.count++;
      else faces.set(key, { e, face, count: 1 });
    });
  const boundary: number[] = [];
  for (const { e, face, count } of faces.values()) {
    if (count > 2) throw new Error('result-invalid: a face is shared by more than two elements');
    if (count === 1)
      boundary.push(...faceTriangles(v.type as 'tet4' | 'tet10', v.elements, e, face));
  }
  // One by one: a large file's connectivity is more arguments than a call takes.
  if (v.type === 'tri3') for (const n of v.elements) boundary.push(n);
  const scalars: ResultScalar[] = [];
  let displacement: Float64Array | undefined;
  for (const d of v.pointData) {
    const { label, unit } = named(d.name);
    if (d.components === 1) scalars.push({ id: d.name, label, unit, values: d.values });
    if (d.components === 3 && /^mode \d/i.test(d.name)) {
      // R3g-2: a mode shape (as resultVtu writes it) moves the mesh itself, scaled to 1 at most.
      const size = magnitude(d.values);
      const max = size.reduce((a, b) => Math.max(a, b), 0);
      const shape = max > 0 ? d.values.map((x) => x / max) : d.values;
      // "Mode 1 (417.5 Hz)": the frequency belongs to the label, the amplitude has no unit.
      scalars.push({
        id: d.name,
        label: unit ? `${label} at ${unit}` : label,
        unit: '',
        values: max > 0 ? size.map((x) => x / max) : size,
        displacement: shape,
      });
      displacement ??= shape;
    } else if (d.components === 3) {
      scalars.push({ id: d.name, label, unit, values: magnitude(d.values) });
      if (!displacement && /^displacement/i.test(d.name)) displacement = d.values;
    }
  }
  return {
    origin,
    nodes: v.nodes,
    tets: v.type === 'tri3' ? new Uint32Array(0) : linearTets(v.type, v.elements),
    triangles: new Uint32Array(boundary),
    ...(displacement ? { displacement } : {}),
    scalars,
  };
}

/** Blue → cyan → green → yellow → red, the usual stress map, at t in [0, 1]. */
const stops: [number, number, number][] = [
  [0.05, 0.19, 0.85],
  [0.0, 0.75, 0.95],
  [0.1, 0.8, 0.25],
  [0.98, 0.85, 0.1],
  [0.86, 0.1, 0.1],
];
export function resultColor(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i]!;
  const b = stops[i + 1]!;
  return [0, 1, 2].map((k) => a[k]! + (b[k]! - a[k]!) * f) as [number, number, number];
}
/** CSS gradient of the map, for the legend. */
export const resultGradient = `linear-gradient(to right, ${stops
  .map((c) => `rgb(${c.map((v) => Math.round(v * 255)).join(' ')})`)
  .join(', ')})`;

/**
 * Range of a scalar over the shown nodes, ignoring non-finite values: the boundary's, or with a
 * section every node's, since a cut shows interior values (interpolated between nodes, so within
 * theirs). The range does not follow the section's place, so the legend stays put while it moves.
 */
export function scalarRange(
  source: ResultSource,
  values: Float64Array,
  sectioned = false,
): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  const nodes = sectioned ? values.keys() : source.triangles;
  for (const n of nodes) {
    const v = values[n]!;
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : [0, 0];
}

/** The model's bounds (mm), per axis. */
export function resultBounds(source: ResultSource): { lo: number[]; hi: number[] } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const { nodes } = source;
  for (let i = 0; i < nodes.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, nodes[i + k]!);
      hi[k] = Math.max(hi[k]!, nodes[i + k]!);
    }
  return { lo, hi };
}

/**
 * The scale that makes the largest displacement a tenth of the model's size: deformation is
 * shown exaggerated by default, as structural tools do. 0 when nothing moved or none is known.
 */
export function autoDeformationScale(source: ResultSource): number {
  const u = source.displacement;
  if (!u) return 0;
  if (source.crash) return 1;
  const { lo, hi } = resultBounds(source);
  const size = Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
  let max = 0;
  for (let i = 0; i < u.length; i += 3)
    max = Math.max(max, Math.hypot(u[i]!, u[i + 1]!, u[i + 2]!));
  return max > 0 && size > 0 ? (0.1 * size) / max : 0;
}

/** A cut by the plane `axis = offset` (undeformed mm); the side above it is removed. */
export interface ResultSection {
  axis: 0 | 1 | 2;
  offset: number;
}

/** The shown surface: a display mesh, a colour and the scalar's value at each of its vertices. */
export interface ResultDisplay {
  mesh: CadMesh;
  colors: Float32Array;
  values: Float32Array;
}

/**
 * The boundary as a display mesh for the CAD viewport, moved by `scale` × displacement, with one
 * colour per vertex over `range`. With a section, the boundary is clipped to the side below the
 * plane and each element the plane cuts adds its cut polygon, coloured by the values interpolated
 * along the cut edges. It has no pick table: a result is looked at, never picked.
 */
export function resultDisplay(
  source: ResultSource,
  scalarId: string,
  scale: number,
  range: [number, number],
  section?: ResultSection,
): ResultDisplay {
  const chosen = source.scalars.find((s) => s.id === scalarId);
  const scalar = chosen?.values ?? new Float64Array(source.nodes.length / 3);
  const u = chosen?.displacement ?? source.displacement;
  const span = range[1] - range[0];
  const positions: number[] = [];
  /** The undeformed place of each shown vertex, relative to the origin. */
  const rest: number[] = [];
  const values: number[] = [];
  const indices: number[] = [];
  const index = new Map<number, number>();
  // Positions near the model, as the kernel's meshes are: Float32 keeps small features and
  // movements of a part far from the world origin.
  const { lo, hi } = resultBounds(source);
  const origin = [0, 1, 2].map((k) => (Number.isFinite(lo[k]!) ? (lo[k]! + hi[k]!) / 2 : 0)) as [
    number,
    number,
    number,
  ];
  const at = (n: number, k: number) =>
    source.nodes[n * 3 + k]! - origin[k]! + (u ? scale * u[n * 3 + k]! : 0);
  const vertex = (n: number) => {
    let i = index.get(n);
    if (i === undefined) {
      i = values.length;
      index.set(n, i);
      positions.push(at(n, 0), at(n, 1), at(n, 2));
      rest.push(...[0, 1, 2].map((k) => source.nodes[n * 3 + k]! - origin[k]!));
      values.push(scalar[n]!);
    }
    return i;
  };
  const side = (n: number) => (section ? source.nodes[n * 3 + section.axis]! - section.offset : -1);
  /** A new vertex on the plane, between nodes p and q (signed distances dp > 0 ≥ dq or the reverse). */
  const between = (p: number, q: number, dp: number, dq: number) => {
    const f = dp / (dp - dq);
    const i = values.length;
    positions.push(...[0, 1, 2].map((k) => at(p, k) + (at(q, k) - at(p, k)) * f));
    rest.push(
      ...[0, 1, 2].map(
        (k) =>
          source.nodes[p * 3 + k]! +
          (source.nodes[q * 3 + k]! - source.nodes[p * 3 + k]!) * f -
          origin[k]!,
      ),
    );
    values.push(scalar[p]! + (scalar[q]! - scalar[p]!) * f);
    return i;
  };
  const tris = source.triangles;
  const allTwoSided = source.tets.length === 0 && !source.twoSided;
  /** Whether each shown triangle is seen from both sides, in `indices` order. */
  const sided: boolean[] = [];
  for (let t = 0; t < tris.length; t += 3) {
    if (chosen?.hidden?.[t / 3]) continue;
    const tri = [tris[t]!, tris[t + 1]!, tris[t + 2]!];
    const d = tri.map(side);
    const two = allTwoSided || source.twoSided?.[t / 3] === 1;
    if (d.every((x) => x <= 0)) {
      indices.push(...tri.map(vertex));
      sided.push(two);
      continue;
    }
    if (d.every((x) => x > 0)) continue;
    // The part below the plane, in the triangle's own winding (one-plane polygon clip).
    const kept: number[] = [];
    for (let k = 0; k < 3; k++) {
      const [p, q] = [tri[k]!, tri[(k + 1) % 3]!];
      const [dp, dq] = [d[k]!, d[(k + 1) % 3]!];
      if (dp <= 0) kept.push(vertex(p));
      if (dp > 0 !== dq > 0) kept.push(between(p, q, dp, dq));
    }
    for (let k = 1; k + 1 < kept.length; k++) {
      indices.push(kept[0]!, kept[k]!, kept[k + 1]!);
      sided.push(two);
    }
  }
  // R3i-5: a shell's midsurface is seen from both sides: each triangle again, reversed, on its
  // own vertices (shared ones would average the two normals away).
  if (sided.some((x) => x)) {
    const front = indices.length;
    const back = new Map<number, number>();
    for (let k = 0; k < front; k += 3)
      if (sided[k / 3])
        indices.push(
          ...[indices[k]!, indices[k + 2]!, indices[k + 1]!].map((v) => {
            let b = back.get(v);
            if (b === undefined) {
              b = values.length;
              back.set(v, b);
              positions.push(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!);
              rest.push(rest[v * 3]!, rest[v * 3 + 1]!, rest[v * 3 + 2]!);
              values.push(values[v]!);
            }
            return b;
          }),
        );
  }
  if (section) {
    const { axis, offset } = section;
    const edges: [number, number][] = [
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 2],
      [1, 3],
      [2, 3],
    ];
    const normal = [0, 0, 0];
    normal[axis] = 1;
    for (let e = 0; e < source.tets.length / 4; e++) {
      const nodes = [0, 1, 2, 3].map((c) => source.tets[e * 4 + c]!);
      const d = nodes.map((n) => source.nodes[n * 3 + axis]! - offset);
      if (d.every((x) => x > 0) || d.every((x) => x <= 0)) continue;
      const cut: number[] = [];
      for (const [i, j] of edges)
        if (d[i]! > 0 !== d[j]! > 0) cut.push(between(nodes[i]!, nodes[j]!, d[i]!, d[j]!));
      // Three or four points: order them around their centre in the undeformed plane, facing
      // +axis, so the cap keeps its winding however far the shown deformation turns it.
      const [s, r] = [(axis + 1) % 3, (axis + 2) % 3];
      const cx = cut.reduce((x, v) => x + rest[v * 3 + s]!, 0) / cut.length;
      const cy = cut.reduce((x, v) => x + rest[v * 3 + r]!, 0) / cut.length;
      cut.sort(
        (v, w) =>
          Math.atan2(rest[v * 3 + r]! - cy, rest[v * 3 + s]! - cx) -
          Math.atan2(rest[w * 3 + r]! - cy, rest[w * 3 + s]! - cx),
      );
      for (let k = 1; k + 1 < cut.length; k++) indices.push(cut[0]!, cut[k]!, cut[k + 1]!);
    }
  }
  const pos = new Float32Array(positions);
  const normals = new Float32Array(pos.length);
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
    const p = (v: number, k: number) => pos[v * 3 + k]!;
    const e1 = [0, 1, 2].map((k) => p(b, k) - p(a, k));
    const e2 = [0, 1, 2].map((k) => p(c, k) - p(a, k));
    const n = [
      e1[1]! * e2[2]! - e1[2]! * e2[1]!,
      e1[2]! * e2[0]! - e1[0]! * e2[2]!,
      e1[0]! * e2[1]! - e1[1]! * e2[0]!,
    ];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) normals[v * 3 + k]! += n[k]!;
  }
  for (let v = 0; v < values.length; v++) {
    const l = Math.hypot(normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!) || 1;
    for (let k = 0; k < 3; k++) normals[v * 3 + k]! /= l;
  }
  const colors = new Float32Array(values.length * 3);
  const classes = chosen?.classes;
  values.forEach((x, i) =>
    colors.set(
      classes
        ? (classes[Math.round(x)]?.color ?? [0.5, 0.5, 0.5])
        : resultColor(span > 0 ? (x - range[0]) / span : 0),
      i * 3,
    ),
  );
  return {
    colors,
    values: new Float32Array(values),
    mesh: {
      bodyId: 'simulation-result',
      origin,
      positions: pos,
      normals,
      indices: new Uint32Array(indices),
      faceIds: new Uint32Array(indices.length / 3),
      vertices: new Float64Array(0),
      faceBase: 0,
      edgeBase: 0,
      edges: new Float32Array(0),
      edgeIds: new Uint32Array(0),
      topology: { faces: [], edges: [], vertices: [] },
    },
  };
}

/** The value at the shown vertex nearest `point` (world mm, on the shown surface) and where it is. */
export function readAt(display: ResultDisplay, point: readonly number[]) {
  const p = display.mesh.positions;
  const o = display.mesh.origin;
  const q = [0, 1, 2].map((k) => point[k]! - o[k]!);
  let best = -1;
  let dist = Infinity;
  for (let v = 0; v < display.values.length; v++) {
    const d = Math.hypot(p[v * 3]! - q[0]!, p[v * 3 + 1]! - q[1]!, p[v * 3 + 2]! - q[2]!);
    if (d < dist) [best, dist] = [v, d];
  }
  return best < 0
    ? undefined
    : {
        value: display.values[best]!,
        at: [0, 1, 2].map((k) => p[best * 3 + k]! + o[k]!) as [number, number, number],
      };
}

/** The VTU (ParaView) of a run's finest mesh with its nodal fields, mm and MPa. */
export const resultVtu = (fields: RunFields, bodyId?: string): string => {
  // VS10b: the bodies, ribbons and the last frame's water.
  if (fields.kind === 'shower') {
    const m = showerMesh(fields);
    return writeVtu({
      mesh: { type: 'tri3', nodes: m.nodes, elements: m.triangles },
      pointData: [{ name: 'Water', components: 1, values: m.water }],
    });
  }
  // VS9b: the seals' ribbons with compression (%), gap (mm) and leak per point.
  if (fields.kind === 'seal') {
    const r = sealRibbonMesh(fields);
    return writeVtu({
      mesh: { type: 'tri3', nodes: r.nodes, elements: r.triangles },
      pointData: [
        { name: 'Compression (%)', components: 1, values: r.compression },
        { name: 'Gap (mm)', components: 1, values: r.gap },
        { name: 'Leak', components: 1, values: r.leak },
      ],
    });
  }
  // VS4c: a wind tunnel's bodies as triangles with Cp (and the Host's Cf and h) per point.
  if (fields.kind === 'aero')
    return writeVtu({
      mesh: { type: 'tri3', nodes: fields.points, elements: fields.triangles },
      pointData: [
        { name: 'Cp', components: 1, values: fields.cp },
        ...(fields.cf ? [{ name: 'Cf', components: 1 as const, values: fields.cf }] : []),
        ...(fields.htc
          ? [
              {
                name: 'Heat transfer coefficient (W per m2 K)',
                components: 1 as const,
                values: fields.htc,
              },
            ]
          : []),
      ],
    });
  // VS7c: a crash run's last frame on all midsurfaces: displacement, plastic strain, erasure.
  if (fields.kind === 'crash') {
    const last = fields.frames.at(-1)!;
    return writeVtu({
      mesh: { type: 'tri3', nodes: fields.nodes, elements: fields.triangles },
      pointData: [
        { name: 'Displacement (mm)', components: 3, values: Float64Array.from(last.displacement) },
      ],
      cellData: [
        { name: 'Plastic strain', components: 1, values: Float64Array.from(last.plasticStrain) },
        { name: 'Erased', components: 1, values: Float64Array.from(last.erased) },
      ],
    });
  }
  // R3j-6c: one body of a bonded run (a VTU holds one kind of element); the source body's when
  // none is named.
  if (fields.kind === 'bonded-static' || fields.kind === 'bonded-modal')
    return resultVtu((fields.bodies.find((b) => b.bodyId === bodyId) ?? fields.bodies[0]!).fields);
  // R3i-4: a shell's midsurface triangles with the thickness per triangle; rotations as their
  // own vector (rad), stresses on the top, middle and bottom surfaces.
  if (fields.kind === 'shell-static' || fields.kind === 'shell-modal') {
    const mesh = {
      type: 'tri3' as const,
      nodes: fields.mesh.nodes,
      elements: fields.mesh.triangles,
    };
    const cellData = [
      { name: 'Thickness (mm)', components: 1 as const, values: fields.mesh.thickness },
    ];
    if (fields.kind === 'shell-modal')
      return writeVtu({
        mesh,
        cellData,
        pointData: fields.modes.map((m, k) => ({
          name: `Mode ${k + 1} (${modeFrequency(m.frequency)} Hz)`,
          components: 3,
          values: translations(m.shape),
        })),
      });
    const rotation = translations(fields.displacement, 3);
    return writeVtu({
      mesh,
      cellData,
      pointData: [
        { name: 'Displacement (mm)', components: 3, values: translations(fields.displacement) },
        { name: 'Rotation (rad)', components: 3, values: rotation },
        { name: 'Stress top (MPa)', components: 6, values: fields.stress.top },
        { name: 'Stress middle (MPa)', components: 6, values: fields.stress.middle },
        { name: 'Stress bottom (MPa)', components: 6, values: fields.stress.bottom },
        { name: 'von Mises top (MPa)', components: 1, values: fields.vonMises.top },
        { name: 'von Mises bottom (MPa)', components: 1, values: fields.vonMises.bottom },
        { name: 'Reaction (N)', components: 3, values: translations(fields.reaction) },
      ],
    });
  }
  // R3g: a modal run's mass-normalised mode shapes, each named with its frequency.
  if (fields.kind === 'modal')
    return writeVtu({
      mesh: fields.mesh,
      pointData: fields.modes.map((m, k) => ({
        name: `Mode ${k + 1} (${modeFrequency(m.frequency)} Hz)`,
        components: 3,
        values: m.shape,
      })),
    });
  // VS11d: every kept temperature, the last flux and the thermal stress.
  if (fields.kind === 'transient-thermal')
    return writeVtu({
      mesh: fields.mesh,
      pointData: [
        ...transientTimeLabels(fields.times).map((label, i) => ({
          name: `Temperature at ${label} (K)`,
          components: 1 as const,
          values: fields.temperatures[i]!,
        })),
        {
          name: 'Heat flux at the end (kW per m²)',
          components: 1 as const,
          values: fields.fluxMagnitude,
        },
        ...(fields.stress
          ? [
              {
                name: 'Displacement (mm)',
                components: 3 as const,
                values: fields.stress.displacement,
              },
              { name: 'Stress (MPa)', components: 6 as const, values: fields.stress.stress },
              { name: 'von Mises (MPa)', components: 1 as const, values: fields.stress.vonMises },
            ]
          : []),
      ],
    });
  // R3h: VTU names take no "/", so the flux's unit is spelled out.
  if (fields.kind === 'thermal')
    return writeVtu({
      mesh: fields.mesh,
      pointData: [
        { name: 'Temperature (K)', components: 1, values: fields.temperature },
        { name: 'Heat flux (kW per m²)', components: 3, values: fields.flux },
      ],
    });
  const principal = principalStresses(fields.stress);
  return writeVtu({
    mesh: fields.mesh,
    pointData: [
      { name: 'Displacement (mm)', components: 3, values: fields.displacement },
      { name: 'Stress (MPa)', components: 6, values: fields.stress },
      { name: 'von Mises (MPa)', components: 1, values: fields.vonMises },
      { name: 'Max principal stress (MPa)', components: 1, values: principal.max },
      { name: 'Min principal stress (MPa)', components: 1, values: principal.min },
      { name: 'Reaction (N)', components: 3, values: fields.reaction },
      ...(fields.fatigue
        ? [
            {
              name: 'Fatigue life (log10 passes)',
              components: 1 as const,
              values: fatigueLogLife(fields.fatigue.life),
            },
            {
              name: 'Fatigue damage per pass',
              components: 1 as const,
              values: fatigueDamageShown(fields.fatigue.damage),
            },
          ]
        : []),
    ],
  });
};
