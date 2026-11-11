import type { FemMesh } from './fem';
import type { ElasticMaterial, ElasticPrepared } from './elastic';

/**
 * CalculiX exchange for the reference Host (R3f, docs/cad/r3-analysis.md A2): the `.inp` input of
 * a linear static study that `prepareElastic` has already mapped to nodes, and the ASCII `.frd`
 * result. Only declarative data goes out (nodes, elements, material values, prescribed DOFs and
 * nodal forces); the `.frd` comes back from outside and is checked in full (`result-invalid`).
 *
 * CalculiX is unitless. `mm` writes the editor's mm–N–MPa values as they are; `m` writes m–N–Pa
 * (the FX1 unit check) and the reader turns the result back into mm and MPa.
 */
export type CalculixUnits = 'mm' | 'm';

export interface CalculixStudy {
  mesh: FemMesh;
  material: ElasticMaterial;
  prepared: ElasticPrepared;
  units?: CalculixUnits;
}

/** Length, stress (and modulus) scale from the editor's mm / MPa to the written units. */
const scales = (units: CalculixUnits) =>
  units === 'm' ? { length: 1e-3, stress: 1e6 } : { length: 1, stress: 1 };

/** CalculiX reads a field of at most 20 characters. */
const fieldWidth = 20;
/**
 * A number in at most 20 characters: the shortest text that reads back to the same double, else
 * as many significant digits as fit (at least 14).
 */
export const calculixNumber = (x: number) => {
  if (!Number.isFinite(x)) throw new RangeError(`not finite: ${x}`);
  const short = String(x);
  if (short.length <= fieldWidth) return short;
  for (let digits = 16; ; digits--) {
    const t = x.toExponential(digits);
    if (t.length <= fieldWidth) return t;
  }
};

/** R3j-5: the element types a CalculiX model is written with. */
export type CalculixElementType = 'tet4' | 'tet10' | 'wedge15';
export const calculixNodesPerElement: Readonly<Record<CalculixElementType, number>> = Object.freeze(
  { tet4: 4, tet10: 10, wedge15: 15 },
);
const calculixElementName: Readonly<Record<CalculixElementType, string>> = {
  tet4: 'C3D4',
  tet10: 'C3D10',
  wedge15: 'C3D15',
};

/** One block of elements of one type and one material. */
export interface CalculixPart {
  type: CalculixElementType;
  elements: ArrayLike<number>;
  /** R3j-5c: `density` (t/mm³) only for a modal model. */
  material: { youngsModulus: number; poissonsRatio: number; density?: number };
}

/**
 * R3j-5: a linear static model as CalculiX takes it: nodes, element blocks (each with its own
 * material), prescribed translations (DOF = 3 · node + direction) and nodal forces. A shell
 * (R3j-5a) comes as its own 15-node wedges (`expandShell`), so the model is always solid.
 */
export interface CalculixModel {
  /** x, y, z per node (mm). */
  nodes: ArrayLike<number>;
  parts: readonly CalculixPart[];
  prescribed: ReadonlyMap<number, number>;
  /** x, y, z per node (N). */
  force: ArrayLike<number>;
  /**
   * Linear homogeneous equations Σ c · u_DOF = 0 (`*EQUATION`); the first term's DOF is the one
   * CalculiX eliminates, so it is neither prescribed nor first in another equation.
   */
  equations?: readonly CalculixEquation[];
  units?: CalculixUnits;
  /**
   * R3j-5c: the lowest `modes` natural modes (`*FREQUENCY`) in place of the static step: every
   * part has a density, every prescribed value is 0, there is no force and the units are mm (the
   * mass-normalised shapes are read back as they are).
   */
  modes?: number;
  /**
   * CR5a: point masses (t) on nodes, `[node, mass]`, written as MASS elements in a modal model
   * (in a static one their weight is already in `force`).
   */
  masses?: readonly (readonly [number, number])[];
}
/** [DOF, coefficient] terms of one equation. */
export type CalculixEquation = readonly (readonly [number, number])[];

/**
 * The `.inp` text. Nodes and elements are numbered from 1 in mesh order; tet10 mid-edge order is
 * the same as CalculiX C3D10 (`tet10Edges`). Loads are the consistent nodal forces (`*CLOAD`), so
 * CalculiX solves the same discrete problem as the browser solver; the result asks for U, RF, S.
 */
export function writeCalculixInp(study: CalculixStudy): string {
  const { mesh, material, prepared } = study;
  return writeCalculixModel({
    nodes: mesh.nodes,
    parts: [{ type: mesh.type, elements: mesh.elements, material }],
    prescribed: prepared.prescribed,
    force: prepared.force,
    ...(study.units ? { units: study.units } : {}),
  });
}

/** The `.inp` of a model: element blocks `P1`, `P2`, … with materials `M1`, `M2`, …. */
export function writeCalculixModel(model: CalculixModel): string {
  const s = scales(model.units ?? 'mm');
  const n = model.nodes.length / 3;
  if (!Number.isInteger(n) || n < 1) throw new RangeError('nodes');
  if (model.force.length !== 3 * n) throw new RangeError('force length');
  if (!model.parts.length) throw new RangeError('no element block');
  const modal = model.modes !== undefined;
  if (modal) {
    if (!Number.isInteger(model.modes) || model.modes! < 1) throw new RangeError('modes');
    if ((model.units ?? 'mm') !== 'mm') throw new RangeError('a modal model is written in mm');
    model.parts.forEach((p, k) => {
      const rho = p.material.density;
      if (!(rho !== undefined && Number.isFinite(rho) && rho > 0))
        throw new RangeError(`part ${k}: a modal model needs a density > 0`);
    });
    for (const [d, v] of model.prescribed)
      if (v !== 0) throw new RangeError(`prescribed DOF ${d}: a modal model holds at 0 only`);
    for (let d = 0; d < model.force.length; d++)
      if (model.force[d] !== 0) throw new RangeError(`force on DOF ${d} in a modal model`);
  }
  const out: string[] = [
    `** editor-platform ${modal ? 'modal' : 'linear static'} study (R3f, R3j-5)`,
    '*NODE, NSET=NALL',
  ];
  for (let p = 0; p < n; p++)
    out.push(
      `${p + 1}, ${calculixNumber(model.nodes[3 * p]! * s.length)}, ${calculixNumber(model.nodes[3 * p + 1]! * s.length)}, ${calculixNumber(model.nodes[3 * p + 2]! * s.length)}`,
    );
  let id = 0;
  model.parts.forEach((part, k) => {
    const npe = calculixNodesPerElement[part.type];
    if (part.elements.length % npe) throw new RangeError(`part ${k}: not ${npe} nodes per element`);
    out.push(`*ELEMENT, TYPE=${calculixElementName[part.type]}, ELSET=P${k + 1}`);
    for (let e = 0; e < part.elements.length / npe; e++) {
      const ids: number[] = [];
      for (let a = 0; a < npe; a++) {
        const p = part.elements[e * npe + a]!;
        if (!Number.isInteger(p) || p < 0 || p >= n)
          throw new RangeError(`part ${k} element ${e} node ${p}`);
        ids.push(p + 1);
      }
      // A record holds at most 16 entries; C3D15 continues on a second line.
      const line = [`${++id}`, ...ids.map(String)];
      out.push(`${line.slice(0, 16).join(', ')}${line.length > 16 ? ',' : ''}`);
      if (line.length > 16) out.push(line.slice(16).join(', '));
    }
  });
  model.parts.forEach((part, k) =>
    out.push(
      `*MATERIAL, NAME=M${k + 1}`,
      '*ELASTIC',
      `${calculixNumber(part.material.youngsModulus * s.stress)}, ${calculixNumber(part.material.poissonsRatio)}`,
      ...(modal ? ['*DENSITY', calculixNumber(part.material.density!)] : []),
      `*SOLID SECTION, ELSET=P${k + 1}, MATERIAL=M${k + 1}`,
    ),
  );
  // CR5a: one MASS element per node mass, an element set per distinct value.
  if (modal && model.masses?.length) {
    const byValue = new Map<string, number[]>();
    for (const [p, m] of model.masses) {
      if (!Number.isInteger(p) || p < 0 || p >= n) throw new RangeError(`mass node ${p}`);
      if (!(m > 0) || !Number.isFinite(m)) throw new RangeError(`mass ${m} on node ${p}`);
      const key = calculixNumber(m);
      // Appended in place: copying the group per node is quadratic on a large, even face.
      const group = byValue.get(key);
      if (group) group.push(p);
      else byValue.set(key, [p]);
    }
    let set = 0;
    for (const [value, nodes] of byValue) {
      out.push(`*ELEMENT, TYPE=MASS, ELSET=AM${++set}`);
      for (const p of nodes) out.push(`${++id}, ${p + 1}`);
      out.push(`*MASS, ELSET=AM${set}`, value);
    }
  }
  const equations = model.equations ?? [];
  if (equations.length) out.push('*EQUATION');
  for (const [k, terms] of equations.entries()) {
    if (terms.length < 2) throw new RangeError(`equation ${k}: fewer than 2 terms`);
    out.push(`${terms.length}`);
    // At most 4 terms (12 entries) on a line.
    for (let a = 0; a < terms.length; a += 4)
      out.push(
        terms
          .slice(a, a + 4)
          .map(([d, c]) => {
            if (!Number.isInteger(d) || d < 0 || d >= 3 * n)
              throw new RangeError(`equation ${k} DOF ${d}`);
            return `${Math.floor(d / 3) + 1}, ${(d % 3) + 1}, ${calculixNumber(c)}`;
          })
          .join(', '),
      );
  }
  out.push('*STEP', ...(modal ? ['*FREQUENCY', `${model.modes}`] : ['*STATIC']), '*BOUNDARY');
  for (const [d, v] of [...model.prescribed].sort((a, b) => a[0] - b[0])) {
    if (!Number.isInteger(d) || d < 0 || d >= 3 * n) throw new RangeError(`prescribed DOF ${d}`);
    const dof = (d % 3) + 1;
    out.push(`${Math.floor(d / 3) + 1}, ${dof}, ${dof}, ${calculixNumber(v * s.length)}`);
  }
  const loads: string[] = [];
  for (let d = 0; d < 3 * n; d++) {
    const f = model.force[d]!;
    if (f !== 0) loads.push(`${Math.floor(d / 3) + 1}, ${(d % 3) + 1}, ${calculixNumber(f)}`);
  }
  // Appended one by one: a spread of 10⁵ records would pass the engine's argument limit.
  if (loads.length) out.push('*CLOAD');
  for (const l of loads) out.push(l);
  // A modal step writes each mode's shape and its internal forces K φ (for the checks).
  out.push('*NODE FILE', 'U, RF', ...(modal ? [] : ['*EL FILE', 'S']), '*END STEP', '');
  return out.join('\n');
}

/** What a `.frd` was refused for; nothing is repaired. */
export type FrdProblem =
  | 'too-large'
  | 'format'
  | 'structure'
  | 'length'
  | 'index'
  | 'not-finite'
  | 'missing';
export class FrdError extends Error {
  readonly code = 'result-invalid';
  constructor(
    readonly problem: FrdProblem,
    readonly detail: string,
  ) {
    super(`result-invalid: ${problem}: ${detail}`);
    this.name = 'FrdError';
  }
}
const refuse = (problem: FrdProblem, detail: string): never => {
  throw new FrdError(problem, detail);
};

export interface FrdResult {
  /** x, y, z per node (mm). */
  displacement: Float64Array;
  /** xx, yy, zz, xy, yz, zx per node (MPa), CalculiX's nodal average. */
  stress: Float64Array;
  /** Internal nodal force K u per node DOF (N): the reaction plus the load at held DOFs. */
  force: Float64Array;
}
export interface FrdReadLimits {
  /** Characters of the whole text. */
  bytes: number;
}
/** CR5f-8: F29's torsion result is 278 MB; the cap stays under V8's longest string (2^29). */
export const frdReadLimits: Readonly<FrdReadLimits> = Object.freeze({ bytes: 480 * 1024 * 1024 });

const blocks = { DISP: 3, STRESS: 6, FORC: 3 } as const;
type BlockName = keyof typeof blocks;

/** One known result block of a `.frd`, with the `100C` header line it came under. */
interface FrdBlock {
  name: BlockName;
  frame: string;
  data: Float64Array;
}

/**
 * Every DISP, STRESS and FORC block of an ASCII `.frd` on `nodes` nodes, in order, each with every
 * node exactly once and finite values; other blocks are skipped without keeping their values.
 */
function scanFrd(text: string, nodes: number, limits: Readonly<FrdReadLimits>): FrdBlock[] {
  if (text.length > limits.bytes) refuse('too-large', `${text.length} characters`);
  const lines = text.split(/\r?\n/);
  const found: FrdBlock[] = [];
  let geometryNodes = -1;
  const lastToken = (line: string) => line.trim().split(/\s+/).pop() ?? '';
  const width = (format: string, where: number) =>
    format === '0'
      ? 5
      : format === '1'
        ? 10
        : refuse('format', `line ${where + 1}: format ${format} (only ASCII)`);
  const nodeId = (line: string, w: number, where: number) => {
    const raw = line.slice(3, 3 + w);
    if (!/^ *\d+$/.test(raw)) refuse('format', `line ${where + 1}: node number`);
    const id = Number(raw);
    if (id < 1 || id > nodes) refuse('index', `line ${where + 1}: node ${id} not in 1..${nodes}`);
    return id - 1;
  };
  const values = (line: string, from: number, count: number, where: number) => {
    const out: number[] = [];
    for (let k = 0; k < count; k++) {
      const raw = line.slice(from + 12 * k, from + 12 * (k + 1));
      if (raw.length !== 12) refuse('length', `line ${where + 1}: ${k} of ${count} values`);
      if (!/^ *[-+]?\d+(\.\d*)?([Ee][-+]?\d+)?$/.test(raw))
        refuse('format', `line ${where + 1}: value ${JSON.stringify(raw)}`);
      const v = Number(raw);
      if (!Number.isFinite(v)) refuse('not-finite', `line ${where + 1}`);
      out.push(v);
    }
    return out;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('    2C')) {
      // Node geometry: only checked for its count.
      const w = width(lastToken(line), i);
      let count = 0;
      for (i++; i < lines.length && !lines[i]!.startsWith(' -3'); i++) {
        if (!lines[i]!.startsWith(' -1')) refuse('structure', `line ${i + 1}: in the node block`);
        nodeId(lines[i]!, w, i);
        count++;
      }
      if (i >= lines.length) refuse('structure', 'node block not closed');
      geometryNodes = count;
      continue;
    }
    if (!line.startsWith('  100C')) continue;
    const w = width(lastToken(line), i);
    const frame = line.trimEnd();
    const head = lines[++i];
    if (!head?.startsWith(' -4')) refuse('structure', `line ${i + 1}: result block without -4`);
    const name = head!.slice(3).trim().split(/\s+/)[0]!;
    // Component records; an "ALL" entry is the vector magnitude CalculiX does not write.
    let components = 0;
    for (i++; i < lines.length && lines[i]!.startsWith(' -5'); i++)
      if (lines[i]!.slice(3).trim().split(/\s+/)[0] !== 'ALL') components++;
    const known = name in blocks ? (name as BlockName) : null;
    if (!known) {
      // Another result CalculiX may write: skipped without reading or keeping its values.
      for (; i < lines.length && !lines[i]!.startsWith(' -3'); i++)
        if (!/^ -[12]/.test(lines[i]!)) refuse('structure', `line ${i + 1}: in the ${name} block`);
      if (i >= lines.length) refuse('structure', `${name} block not closed`);
      continue;
    }
    if (components !== blocks[known])
      refuse('structure', `${name} has ${components} components, not ${blocks[known]}`);
    const data = new Float64Array(nodes * components);
    const seen = new Uint8Array(nodes);
    let count = 0;
    for (; i < lines.length && !lines[i]!.startsWith(' -3'); i++) {
      if (!lines[i]!.startsWith(' -1')) refuse('structure', `line ${i + 1}: in the ${name} block`);
      const p = nodeId(lines[i]!, w, i);
      if (seen[p]) refuse('index', `line ${i + 1}: node ${p + 1} twice in ${name}`);
      seen[p] = 1;
      count++;
      // Up to 6 values per record, the rest on -2 continuation records.
      const got: number[] = [];
      let rec = lines[i]!;
      let from = 3 + w;
      for (;;) {
        const take = Math.min(6, components - got.length);
        got.push(...values(rec, from, take, i));
        if (got.length === components) break;
        rec = lines[++i] ?? '';
        if (!rec.startsWith(' -2')) refuse('structure', `line ${i + 1}: ${name} record continues`);
        from = 3 + w;
      }
      data.set(got, p * components);
    }
    if (i >= lines.length) refuse('structure', `${name} block not closed`);
    if (count !== nodes) refuse('length', `${name} has ${count} nodes, not ${nodes}`);
    found.push({ name: known, frame, data });
  }
  if (geometryNodes !== nodes)
    refuse('length', `the result has ${geometryNodes} nodes, not ${nodes}`);
  return found;
}

/**
 * Reads the ASCII `.frd` CalculiX writes for `writeCalculixInp`'s study on a mesh of `nodes`
 * nodes: the DISP, STRESS and FORC blocks of the last step, each with every node exactly once and
 * finite values. Binary results, other node counts, unknown or out-of-range node numbers, short
 * records and missing blocks are refused. Values have CalculiX's 6 significant digits.
 */
export function readCalculixFrd(
  text: string,
  nodes: number,
  units: CalculixUnits = 'mm',
  limits: Readonly<FrdReadLimits> = frdReadLimits,
): FrdResult {
  const s = scales(units);
  const found = new Map<BlockName, FrdBlock>();
  const all = scanFrd(text, nodes, limits);
  for (const b of all) found.set(b.name, b);
  const lastFrame = all.at(-1)?.frame ?? null;
  // All three from the last result frame: a later step with only some of them is not mixed with
  // an earlier one.
  for (const name of Object.keys(blocks) as BlockName[])
    if (found.get(name)?.frame !== lastFrame)
      refuse('missing', `no ${name} block in the last result frame`);
  // A finite value in m or Pa can overflow in mm or MPa: checked again after the conversion.
  const converted = (name: BlockName, scale: number) => {
    const out = found.get(name)!.data.map((v) => v / scale);
    if (!out.every(Number.isFinite)) refuse('not-finite', `${name} in ${units}`);
    return out;
  };
  return {
    displacement: converted('DISP', s.length),
    stress: converted('STRESS', s.stress),
    force: found.get('FORC')!.data,
  };
}

/** R3j-5c: one natural mode as CalculiX gives it for a modal model (mm, N, t, s). */
export interface FrdMode {
  /** Hz, from the frame header (10 significant digits). */
  frequency: number;
  /** ω² = (2π f)² (1/s²). */
  eigenvalue: number;
  /** x, y, z per node, mass-normalised by CalculiX (φᵀ M φ = 1). */
  shape: Float64Array;
  /** The internal nodal forces K φ, x, y, z per node. */
  force: Float64Array;
}

/**
 * R3j-5c: the `modes` (or `min`–`max`) natural modes of a modal model's `.frd` on `nodes` nodes, lowest first:
 * for each a MODAL frame numbered 1, 2, … in order with its DISP and FORC blocks and a finite
 * frequency ≥ 0 not below the one before. Fewer or more modes, a frame of another analysis, a
 * mode with only one of its blocks and everything `readCalculixFrd` refuses are refused.
 */
export function readCalculixModes(
  text: string,
  nodes: number,
  modes: number | { min: number; max: number },
  limits: Readonly<FrdReadLimits> = frdReadLimits,
): FrdMode[] {
  const out: FrdMode[] = [];
  const pending = new Map<string, { DISP?: Float64Array; FORC?: Float64Array }>();
  const order: string[] = [];
  for (const b of scanFrd(text, nodes, limits)) {
    if (b.name === 'STRESS') continue;
    if (!pending.has(b.frame)) {
      pending.set(b.frame, {});
      order.push(b.frame);
    }
    const got = pending.get(b.frame)!;
    if (got[b.name]) refuse('structure', `${b.name} twice in the frame ${b.frame}`);
    got[b.name] = b.data;
  }
  for (const frame of order) {
    // 1X, ' 100', 'C', SETNAME 6A1, VALUE E12, NUMNOD I12, TEXT 20A1, ICTYPE I2, NUMSTP I5, ANALYS 10A1.
    if (frame.slice(63, 73).trim() !== 'MODAL') refuse('structure', `not a modal frame: ${frame}`);
    const number = Number(frame.slice(58, 63));
    if (number !== out.length + 1) refuse('structure', `mode ${number} after ${out.length}`);
    const raw = frame.slice(12, 24);
    if (!/^ *[-+]?\d+(\.\d*)?([Ee][-+]?\d+)?$/.test(raw))
      refuse('format', `mode ${number} frequency ${JSON.stringify(raw)}`);
    const frequency = Number(raw);
    if (!(Number.isFinite(frequency) && frequency >= 0))
      refuse('not-finite', `mode ${number} frequency`);
    if (out.length && frequency < out.at(-1)!.frequency)
      refuse('structure', `mode ${number} below mode ${number - 1}`);
    const { DISP, FORC } = pending.get(frame)!;
    if (!DISP || !FORC) refuse('missing', `mode ${number} has no ${DISP ? 'FORC' : 'DISP'} block`);
    out.push({
      frequency,
      eigenvalue: (2 * Math.PI * frequency) ** 2,
      shape: DISP!,
      force: FORC!,
    });
  }
  const { min, max } = typeof modes === 'number' ? { min: modes, max: modes } : modes;
  if (out.length < min || out.length > max)
    refuse('missing', `${out.length} modes, not ${min === max ? min : `${min}–${max}`}`);
  return out;
}
