/**
 * CS4 (docs/cad/construction-site.md, CS-U5): a frame of beam elements for the reference Host
 * (CalculiX). Each member is cut into 2-node beams of CalculiX's user element `U1` (six DOFs per
 * node, not expanded into bricks: an expanded `B32R` frame of one storey took CalculiX over a
 * minute for its rigid-joint equations). Elements of one section, depth direction and material
 * form a group. Joints are rigid (shared nodes), held nodes are fixed in all six DOFs, and every
 * load is a nodal force (own weight lumped to the ends). Only numbers go out, and the `.frd` that
 * comes back is checked in full.
 *
 * CalculiX gives the nodes' translations and rotations; the element end forces are recovered here
 * from them with the beam's own stiffness (no load acts inside an element), and each element's
 * stress is the largest |N|/A + |M₁|·c₁/I₁₁ + |M₂|·c₂/I₂₂ of its two ends: the normal stress at the
 * section's extreme fibres (axial plus both bendings; for a rectangle, a box or an H the corner's).
 *
 * The `.frd` has 6 significant digits, so a member's stretch read as the difference of its ends'
 * translations is good to about 1e-5 of the frame's largest displacement.
 */
import { calculixNumber, FrdError, frdReadLimits, type FrdReadLimits } from './calculix';

/**
 * A section by its properties (mm², mm⁴): area, second moments about the axes across the depth
 * (`i11`: bending in the depth direction) and across the width, the torsion constant, and the
 * distances from the centroid to the extreme fibre along the depth (`c1`) and the width (`c2`).
 * A round section (`round`: a circle or a tube) bends about the resultant moment: its extreme
 * fibre lies on the perimeter, not at a corner.
 */
export interface FrameSection {
  area: number;
  i11: number;
  i22: number;
  torsion: number;
  c1: number;
  c2: number;
  round?: true;
}

export interface FrameMaterial {
  /** MPa. */
  youngsModulus: number;
  poissonsRatio: number;
}

/** Elements of one section, depth direction and material. */
export interface FrameGroup {
  section: FrameSection;
  /** The section's depth direction: any vector not along the elements' axes. */
  depthDirection: [number, number, number];
  material: FrameMaterial;
  /** 2 node indices per element. */
  elements: number[];
}

export interface FrameModel {
  /** x, y, z per node (mm). */
  nodes: number[];
  groups: FrameGroup[];
  /** Nodes held in all six DOFs. */
  fixed: number[];
  /** [node, fx, fy, fz] (N). */
  force: [number, number, number, number][];
}

export interface FrameLimits {
  nodes: number;
  elements: number;
  groups: number;
}
/** CS4: an 8-storey frame is a few thousand nodes; the Host takes far more. */
export const frameLimits: Readonly<FrameLimits> = Object.freeze({
  nodes: 200_000,
  elements: 200_000,
  groups: 2000,
});

export type FrameProblem = 'too-large' | 'shape' | 'not-finite' | 'index' | 'material' | 'section';
export class FrameModelError extends Error {
  readonly code = 'frame-invalid';
  constructor(
    readonly problem: FrameProblem,
    readonly detail: string,
  ) {
    super(`frame-invalid: ${problem}: ${detail}`);
    this.name = 'FrameModelError';
  }
}
const refuse = (problem: FrameProblem, detail: string): never => {
  throw new FrameModelError(problem, detail);
};
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const positive = (x: unknown): x is number => finite(x) && x > 0;
const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const keysOnly = (value: Record<string, unknown>, keys: string[], what: string) => {
  for (const k of Object.keys(value))
    if (!keys.includes(k)) refuse('shape', `${what}unknown key ${k}`);
};
const sectionKeys = ['area', 'i11', 'i22', 'torsion', 'c1', 'c2'] as const;

const vec = (value: unknown, what: string): [number, number, number] => {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(finite))
    return refuse('shape', what);
  return [value[0] as number, value[1] as number, value[2] as number];
};

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const unit = (a: V3): V3 => scale(a, 1 / Math.hypot(...a));

/**
 * Checks a frame as it arrives (from JSON, so anything): keys, sizes against `limits`, finite
 * numbers, node indices, sections and materials, each element's ends apart and its depth direction
 * off its axis, each node fixed once and loaded once. Returns the model `writeCalculixFrame` writes.
 */
export function checkFrameModel(
  value: unknown,
  limits: Readonly<FrameLimits> = frameLimits,
): FrameModel {
  if (!isObject(value)) return refuse('shape', 'not an object');
  keysOnly(value, ['nodes', 'groups', 'fixed', 'force'], '');
  const { nodes, groups, fixed, force } = value;
  if (!Array.isArray(nodes) || !nodes.length || nodes.length % 3)
    return refuse('shape', 'nodes is not x, y, z per node');
  const n = nodes.length / 3;
  if (n > limits.nodes) refuse('too-large', `${n} nodes > ${limits.nodes}`);
  if (!nodes.every(finite)) refuse('not-finite', 'nodes');
  const node = (p: unknown, what: string) => {
    if (!Number.isInteger(p) || (p as number) < 0 || (p as number) >= n) refuse('index', what);
    return p as number;
  };
  const at = (p: number): V3 => [nodes[3 * p], nodes[3 * p + 1], nodes[3 * p + 2]] as V3;
  if (!Array.isArray(groups) || !groups.length) return refuse('shape', 'groups');
  if (groups.length > limits.groups)
    refuse('too-large', `${groups.length} groups > ${limits.groups}`);
  let m = 0;
  const checked = groups.map((g, k): FrameGroup => {
    if (!isObject(g)) return refuse('shape', `group ${k}`);
    keysOnly(g, ['section', 'depthDirection', 'material', 'elements'], `group ${k}: `);
    const s = g.section;
    if (!isObject(s)) return refuse('section', `group ${k}`);
    keysOnly(s, [...sectionKeys, 'round'], `group ${k} section: `);
    for (const key of sectionKeys)
      if (!positive(s[key])) refuse('section', `group ${k}: ${key} > 0`);
    if (s.round !== undefined && s.round !== true) refuse('section', `group ${k}: round is true`);
    const dir = vec(g.depthDirection, `group ${k} depthDirection`);
    const dl = Math.hypot(...dir);
    if (!(dl > 0)) refuse('shape', `group ${k}: depthDirection is zero`);
    if (!isObject(g.material)) return refuse('material', `group ${k}`);
    keysOnly(g.material, ['youngsModulus', 'poissonsRatio'], `group ${k} material: `);
    const { youngsModulus: E, poissonsRatio: nu } = g.material;
    if (!positive(E) || !finite(nu) || !(nu > -1 && nu < 0.5))
      refuse('material', `group ${k}: E > 0, −1 < ν < 0.5`);
    if (!Array.isArray(g.elements) || !g.elements.length || g.elements.length % 2)
      return refuse('shape', `group ${k}: elements is not 2 per element`);
    m += g.elements.length / 2;
    if (m > limits.elements) refuse('too-large', `${m} elements > ${limits.elements}`);
    const elements = (g.elements as unknown[]).map((p, i) => node(p, `group ${k} entry ${i}`));
    for (let e = 0; e < elements.length; e += 2) {
      const axis = sub(at(elements[e + 1]!), at(elements[e]!));
      const len = Math.hypot(...axis);
      if (!(len > 1e-6)) refuse('shape', `group ${k} element ${e / 2}: its ends meet`);
      if (Math.hypot(...cross(axis, dir)) < 1e-6 * len * dl)
        refuse('shape', `group ${k} element ${e / 2}: the depth direction is along its axis`);
    }
    return {
      section: {
        ...Object.fromEntries(sectionKeys.map((key) => [key, s[key]])),
        ...(s.round ? { round: true } : {}),
      } as never,
      depthDirection: dir,
      material: { youngsModulus: E as number, poissonsRatio: nu as number },
      elements,
    };
  });
  if (!Array.isArray(fixed) || !fixed.length) return refuse('shape', 'nothing is fixed');
  const held = new Set<number>();
  for (const [i, p] of fixed.entries()) {
    const q = node(p, `fixed ${i}`);
    if (held.has(q)) refuse('index', `fixed ${i}: node ${q} twice`);
    held.add(q);
  }
  if (!Array.isArray(force)) return refuse('shape', 'force');
  if (force.length > n) refuse('too-large', 'force');
  const loaded = new Set<number>();
  const forces = force.map((f, i): [number, number, number, number] => {
    if (!Array.isArray(f) || f.length !== 4) return refuse('shape', `force ${i}`);
    const q = node(f[0], `force ${i}`);
    if (loaded.has(q)) refuse('index', `force ${i}: node ${q} twice`);
    loaded.add(q);
    if (!f.slice(1).every(finite)) refuse('not-finite', `force ${i}`);
    return [q, f[1] as number, f[2] as number, f[3] as number];
  });
  return { nodes: nodes as number[], groups: checked, fixed: [...held], force: forces };
}

/** The `.inp` of a frame (check it first with `checkFrameModel`). Elements are numbered from 1. */
export function writeCalculixFrame(model: FrameModel): string {
  const num = calculixNumber;
  const n = model.nodes.length / 3;
  const out: string[] = ['** editor-platform frame study (CS4)', '*NODE, NSET=NALL'];
  for (let p = 0; p < n; p++)
    out.push(
      `${p + 1}, ${num(model.nodes[3 * p]!)}, ${num(model.nodes[3 * p + 1]!)}, ${num(model.nodes[3 * p + 2]!)}`,
    );
  out.push('*USER ELEMENT, TYPE=U1, INTEGRATION POINTS=2, MAXDOF=6, NODES=2');
  let id = 0;
  model.groups.forEach((g, k) => {
    out.push(`*ELEMENT, TYPE=U1, ELSET=G${k + 1}`);
    for (let e = 0; e < g.elements.length; e += 2)
      out.push(`${++id}, ${g.elements[e]! + 1}, ${g.elements[e + 1]! + 1}`);
  });
  model.groups.forEach((g, k) => {
    const s = g.section;
    out.push(
      `*MATERIAL, NAME=M${k + 1}`,
      '*ELASTIC',
      `${num(g.material.youngsModulus)}, ${num(g.material.poissonsRatio)}`,
      // U1: area, I11, I12 (0: principal axes), I22, torsion, the depth direction, no offsets.
      `*USER SECTION, ELSET=G${k + 1}, MATERIAL=M${k + 1}, CONSTANTS=10`,
      [s.area, s.i11, 0, s.i22, s.torsion, ...g.depthDirection, 0, 0].map(num).join(', '),
    );
  });
  out.push('*BOUNDARY');
  for (const p of model.fixed) out.push(`${p + 1}, 1, 6, 0`);
  out.push('*STEP', '*STATIC');
  const loads = model.force.flatMap(([p, ...f]) =>
    f.flatMap((v, d) => (v !== 0 ? [`${p + 1}, ${d + 1}, ${num(v)}`] : [])),
  );
  if (loads.length) out.push('*CLOAD', ...loads);
  out.push('*NODE FILE', 'U', '*END STEP', '');
  return out.join('\n');
}

export interface FrameElementForces {
  /** Axial force (N, tension positive), at the two ends. */
  axial: [number, number];
  /** Bending moments (N·mm) in the depth direction and across it, at the two ends. */
  moment1: [number, number];
  moment2: [number, number];
}

export interface FrameResult {
  /** x, y, z per model node (mm). */
  displacement: Float64Array;
  /** x, y, z rotation per model node (rad). */
  rotation: Float64Array;
  /** Per element (in group order): the largest extreme-fibre normal stress (MPa). */
  stress: Float64Array;
  forces: FrameElementForces[];
}

const frdRefuse = (problem: ConstructorParameters<typeof FrdError>[0], detail: string): never => {
  throw new FrdError(problem, detail);
};

/** The end forces of a 2-node beam from its ends' translations and rotations (no inner load). */
export function frameElementForces(
  a: V3,
  b: V3,
  depthDirection: V3,
  section: FrameSection,
  youngsModulus: number,
  ua: V3,
  ra: V3,
  ub: V3,
  rb: V3,
): FrameElementForces {
  const d = sub(b, a);
  const L = Math.hypot(...d);
  const x = scale(d, 1 / L);
  const e1 = unit(sub(depthDirection, scale(x, dot(depthDirection, x))));
  const e2 = cross(x, e1);
  const E = youngsModulus;
  const N = ((E * section.area) / L) * (dot(ub, x) - dot(ua, x));
  // Deflection w along e and its slope; M = E·I·w'' of the cubic through both ends.
  const bend = (e: V3, slope: (r: V3) => number, I: number): [number, number] => {
    const dw = dot(ub, e) - dot(ua, e);
    const [sa, sb] = [slope(ra), slope(rb)];
    return [
      E * I * ((6 * dw) / (L * L) - (4 * sa + 2 * sb) / L),
      E * I * ((-6 * dw) / (L * L) + (2 * sa + 4 * sb) / L),
    ];
  };
  return {
    axial: [N, N],
    // A rotation r turns the axis towards e1 by r·e2, and towards e2 by −r·e1.
    moment1: bend(e1, (r) => dot(r, e2), section.i11),
    moment2: bend(e2, (r) => -dot(r, e1), section.i22),
  };
}

/**
 * Reads the ASCII `.frd` CalculiX writes for `writeCalculixFrame(model)`: the DISP of the last
 * step, six values (translations and rotations) for every model node, finite. Anything else is
 * refused (`result-invalid`). The end forces and stresses are recovered from it.
 */
export function readCalculixFrame(
  model: FrameModel,
  text: string,
  limits: Readonly<FrdReadLimits> = frdReadLimits,
): FrameResult {
  if (text.length > limits.bytes) frdRefuse('too-large', `${text.length} characters`);
  const n = model.nodes.length / 3;
  const lines = text.split(/\r?\n/);
  let disp: Float64Array | undefined;
  let geometry = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('    2C')) {
      let count = 0;
      for (i++; i < lines.length && !lines[i]!.startsWith(' -3'); i++) count++;
      geometry = count;
      continue;
    }
    if (!line.startsWith(' -4')) continue;
    const name = line.slice(3).trim().split(/\s+/)[0]!;
    for (i++; i < lines.length && lines[i]!.startsWith(' -5'); i++);
    const data = name === 'DISP' ? new Float64Array(6 * n) : undefined;
    const seen = new Uint8Array(n);
    for (; i < lines.length && !lines[i]!.startsWith(' -3'); i++) {
      const l = lines[i]!;
      if (!/^ -[12]/.test(l)) frdRefuse('structure', `line ${i + 1}: in the ${name} block`);
      if (!data || !l.startsWith(' -1')) continue;
      const raw = l.slice(3, 13);
      if (!/^ *\d+$/.test(raw)) frdRefuse('format', `line ${i + 1}: node number`);
      const p = Number(raw) - 1;
      if (p < 0 || p >= n) frdRefuse('index', `line ${i + 1}: node ${p + 1}`);
      if (seen[p]) frdRefuse('index', `line ${i + 1}: node ${p + 1} twice`);
      seen[p] = 1;
      for (let k = 0; k < 6; k++) {
        const v = l.slice(13 + 12 * k, 25 + 12 * k);
        if (!/^ *[-+]?\d+(\.\d*)?([Ee][-+]?\d+)?$/.test(v))
          frdRefuse('format', `line ${i + 1}: value ${JSON.stringify(v)}`);
        const x = Number(v);
        if (!Number.isFinite(x)) frdRefuse('not-finite', `line ${i + 1}`);
        data[6 * p + k] = x;
      }
    }
    if (i >= lines.length) frdRefuse('structure', `${name} block not closed`);
    if (data) {
      if (seen.some((s) => !s)) frdRefuse('length', 'DISP misses nodes');
      disp = data;
    }
  }
  if (geometry !== n) frdRefuse('length', `the result has ${geometry} nodes, not ${n}`);
  if (!disp) return frdRefuse('missing', 'no DISP block');
  const displacement = new Float64Array(3 * n);
  const rotation = new Float64Array(3 * n);
  for (let p = 0; p < n; p++)
    for (let k = 0; k < 3; k++) {
      displacement[3 * p + k] = disp[6 * p + k]!;
      rotation[3 * p + k] = disp[6 * p + 3 + k]!;
    }
  const v = (arr: Float64Array, p: number): V3 => [arr[3 * p]!, arr[3 * p + 1]!, arr[3 * p + 2]!];
  const at = (p: number): V3 => [
    model.nodes[3 * p]!,
    model.nodes[3 * p + 1]!,
    model.nodes[3 * p + 2]!,
  ];
  const stress: number[] = [];
  const forces: FrameElementForces[] = [];
  for (const g of model.groups)
    for (let e = 0; e < g.elements.length; e += 2) {
      const [a, b] = [g.elements[e]!, g.elements[e + 1]!];
      const f = frameElementForces(
        at(a),
        at(b),
        g.depthDirection,
        g.section,
        g.material.youngsModulus,
        v(displacement, a),
        v(rotation, a),
        v(displacement, b),
        v(rotation, b),
      );
      const s = g.section;
      // A rectangle, box or H has its extreme fibres meet at a corner; a round section's lies
      // where the resultant moment points.
      const end = (k: 0 | 1) =>
        Math.abs(f.axial[k]) / s.area +
        (s.round
          ? (Math.hypot(f.moment1[k], f.moment2[k]) * s.c1) / s.i11
          : (Math.abs(f.moment1[k]) * s.c1) / s.i11 + (Math.abs(f.moment2[k]) * s.c2) / s.i22);
      stress.push(Math.max(end(0), end(1)));
      forces.push(f);
    }
  return { displacement, rotation, stress: Float64Array.from(stress), forces };
}
