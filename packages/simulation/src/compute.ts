/**
 * R3f-2: the optional compute capability a Host may give the simulation editor (docs/cad/roadmap.md
 * F3, docs/cad/r3-analysis.md A2). A Host names itself, where the data goes, its limits and its
 * solver; a job carries only declarative data (nodes, elements, material values, prescribed DOFs
 * and nodal forces) and returns CalculiX's `.frd`, which the editor checks in full. Without a
 * compute Host the editor works as before: editing, saving and browser runs never need one.
 *
 * Pure: the reference Host server (scripts/dev/simulation-host.mjs) uses `computeJobInp` too, so
 * a job is checked the same way on both sides and the `.inp` is always written from numbers.
 */
import type { AeroHostResult, AeroJob } from '@editor-platform/geometry-cfd';
import {
  bondedHostModel,
  bondedModalHostModel,
  bondedModalResultFromFrd,
  bondedResultFromFrd,
  calculixModeCount,
  modalHostModel,
  modalResultFromFrd,
  readCalculixModes,
  shellModalHostModel,
  shellModalResultFromFrd,
  type BondedModalInput,
  type BondedModalResult,
  type ModalInput,
  type ModalResult,
  type ShellModalInput,
  type ShellModalResult,
  calculixNodesPerElement,
  expandShell,
  expandShellStudy,
  prepareElastic,
  prepareShell,
  readCalculixFrd,
  shellResultFromFrd,
  vonMisesOf,
  writeCalculixModel,
  type BondedInput,
  type BondedResult,
  type CalculixElementType,
  type CalculixModel,
  type CalculixUnits,
  type ShellInput,
  type ShellResult,
  type ElasticInput,
  type ElasticMaterial,
  type ElasticPrepared,
  type ElasticResult,
  type FrdResult,
  type FemMesh,
  checkFrameModel,
  FrameModelError,
  readCalculixFrame,
  writeCalculixFrame,
  type FrameModel,
  type FrameResult,
  crashJobOf,
  readCrashResult,
  type CrashJob,
  type ExplicitModel,
  type ExplicitResult,
  type ExplicitSettings,
  FrdError,
  readCalculixTemperatures,
  solveTransientThermal,
  transientCalculixModel,
  writeCalculixHeat,
  type CalculixHeatFace,
  type CalculixHeatModel,
  type ElasticThermal,
  type TransientInput,
  type TransientResult,
} from '@editor-platform/geometry-fem';

export interface SimulationComputeLimits {
  nodes: number;
  elements: number;
  /** Characters of the job's JSON. */
  bytes: number;
}
/**
 * The reference Host's limits (A2: re-measured in R3f-3). CR5f-8 (docs/cad/car-design.md): raised
 * from 200,000 nodes, 140,000 elements and 64 MiB so the simplified BIW F29 is solved from the
 * app (at 30 mm the Host is sent about 0.99M nodes, 0.2M elements and a job of about 0.1 GB; the
 * CalculiX run took 186 s and 10.8 GB in the CR5f measurements).
 */
export const referenceComputeLimits: Readonly<SimulationComputeLimits> = Object.freeze({
  nodes: 1_500_000,
  elements: 1_000_000,
  bytes: 256 * 1024 * 1024,
});

/** What a Host says about its compute capability, before anything is sent. */
export interface SimulationComputeDescriptor {
  /** Shown to the user as the destination of the data, e.g. "Reference Host (this dev server)". */
  label: string;
  /** Where the data goes, shown before sending. */
  destination: string;
  /** Recorded with each run as the solver build, e.g. "calculix-2.21". */
  solverBuild: string;
  limits: SimulationComputeLimits;
  /** The job endpoint (same origin). */
  endpoint: string;
  /**
   * VS3b: the Host also runs wind-tunnel jobs (`kind: 'aero'`, geometry-cfd's `AeroJob`) on this
   * OpenFOAM build, e.g. "openfoam-2412".
   */
  aero?: { solverBuild: string };
  /** VS8a: the Host also runs crash jobs (`kind: 'crash'`) on the explicit solver in Node. */
  crash?: { solverBuild: string };
}

/** Everything a job sends. Numbers only: no names, document content or credentials. */
export interface SimulationComputeJob {
  /** R3j-5c: `modal` solves for the lowest `modes` natural modes (mm only, held at 0, no force). */
  kind: 'linear-static' | 'modal';
  modes?: number;
  units: CalculixUnits;
  /** x, y, z per node (mm). */
  nodes: number[];
  /**
   * Element blocks, each of one type and material (R3j-5: a shell comes as its own 15-node
   * wedges, `expandShell`; several bodies as several blocks).
   */
  parts: {
    type: CalculixElementType;
    elements: number[];
    /** `density` (t/mm³) in a modal job only; `expansion` (1/K) in a thermal one only. */
    material: {
      youngsModulus: number;
      poissonsRatio: number;
      density?: number;
      expansion?: number;
    };
  }[];
  /** [DOF, mm] pairs, DOF = 3 · node + direction. */
  prescribed: [number, number][];
  /** [DOF, N] pairs of the non-zero nodal forces. */
  force: [number, number][];
  /** R3j-5: homogeneous equations, each [DOF, coefficient] terms, the first the eliminated one. */
  equations: [number, number][][];
  /** CR5a: [node, t] point masses, in a modal job only. */
  masses?: [number, number][];
  /** VS11d-3: a static job's nodal temperature (K) and strain-free temperature (thermal stress). */
  thermal?: { temperature: number[]; reference: number };
}

/**
 * VS11d-3: a transient heat transfer job (`writeCalculixHeat`'s model, as JSON numbers): the mesh,
 * the material, the start, the time, the amplitudes, the held nodes, the face conditions and the
 * nodal heats. Its result is the `.frd` of every step's temperature.
 */
export interface TransientComputeJob {
  kind: 'transient-thermal';
  heat: {
    nodes: number[];
    type: 'tet4' | 'tet10';
    elements: number[];
    material: { conductivity: number; density: number; specificHeat: number };
    initialTemperature: number[];
    time: { end: number; step: number };
    amplitudes: { times: number[]; factors: number[] }[];
    holds: { nodes: number[]; temperature: number; amplitude?: number }[];
    faces: CalculixHeatFace[];
    nodal: { node: number; heat: number; amplitude?: number }[];
  };
}
/**
 * VS11d-3: a transient job's steps × nodes at most (each step's temperatures come back, about
 * 27 bytes a value in the `.frd`), and the amplitude points and face conditions it may have.
 */
export const computeTransientShape = Object.freeze({
  values: 10_000_000,
  amplitudePoints: 20_010,
  amplitudes: 1_000,
});
/**
 * VS11d-3: what a Host's transient run is checked with, replayed through the browser's equations:
 * the largest step residual (CalculiX writes 6 significant digits) and the energy balance.
 */
export const computeTransientResidual = 2e-3;
export const computeTransientBalance = 1e-4;

/** How many element blocks, terms of one equation and modes a job may have. */
export const computeJobShape = Object.freeze({ parts: 64, terms: 64, modes: 100 });

export type ComputeJobProblem = 'too-large' | 'shape' | 'not-finite' | 'index' | 'material';
export class ComputeJobError extends Error {
  readonly code = 'compute-job-invalid';
  constructor(
    readonly problem: ComputeJobProblem,
    readonly detail: string,
  ) {
    super(`compute-job-invalid: ${problem}: ${detail}`);
    this.name = 'ComputeJobError';
  }
}
const refuse = (problem: ComputeJobProblem, detail: string): never => {
  throw new ComputeJobError(problem, detail);
};

/** The job of a study that `prepareElastic` mapped to nodes. */
export function computeJobOf(
  mesh: FemMesh,
  material: ElasticMaterial,
  prepared: ElasticPrepared,
  units: CalculixUnits = 'mm',
  thermal?: ElasticThermal,
): SimulationComputeJob {
  return computeJobOfModel(
    {
      nodes: mesh.nodes,
      parts: [
        {
          type: mesh.type,
          elements: mesh.elements,
          material: thermal ? { ...material, expansion: thermal.expansion } : material,
        },
      ],
      prescribed: prepared.prescribed,
      force: prepared.force,
      ...(thermal
        ? { thermal: { temperature: thermal.temperature, reference: thermal.reference } }
        : {}),
    },
    units,
  );
}

/** R3j-5: the job of any model (a shell's wedges, several bodies). */
export function computeJobOfModel(
  model: CalculixModel,
  units: CalculixUnits = 'mm',
): SimulationComputeJob {
  const force: [number, number][] = [];
  for (let d = 0; d < model.force.length; d++) {
    const f = model.force[d]!;
    if (f !== 0) force.push([d, f]);
  }
  const modal = model.modes !== undefined;
  return {
    kind: modal ? 'modal' : 'linear-static',
    ...(modal ? { modes: model.modes! } : {}),
    units,
    nodes: Array.from(model.nodes),
    parts: model.parts.map((p) => ({
      type: p.type,
      elements: Array.from(p.elements),
      material: {
        youngsModulus: p.material.youngsModulus,
        poissonsRatio: p.material.poissonsRatio,
        ...(modal ? { density: p.material.density! } : {}),
        ...(model.thermal ? { expansion: p.material.expansion! } : {}),
      },
    })),
    prescribed: [...model.prescribed].sort((a, b) => a[0] - b[0]),
    force,
    equations: (model.equations ?? []).map((e) => e.map(([d, c]): [number, number] => [d, c])),
    ...(modal && model.masses?.length
      ? { masses: model.masses.map(([p, m]): [number, number] => [p, m]) }
      : {}),
    ...(model.thermal
      ? {
          thermal: {
            temperature: Array.from(model.thermal.temperature),
            reference: model.thermal.reference,
          },
        }
      : {}),
  };
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const keysOnly = (value: Record<string, unknown>, keys: string[], what: string) => {
  for (const k of Object.keys(value))
    if (!keys.includes(k)) refuse('shape', `${what}unknown key ${k}`);
};

/**
 * Checks a job as it arrives (from JSON, so anything): its keys, sizes against `limits`, every
 * number finite, element node and DOF indices in range, each DOF once, valid materials, and each
 * equation's eliminated DOF neither held nor eliminated twice. Returns the model
 * `writeCalculixModel` writes; refuses anything else.
 */
export function checkComputeJob(
  value: unknown,
  limits: Readonly<SimulationComputeLimits> = referenceComputeLimits,
): CalculixModel & { units: CalculixUnits } {
  if (!isObject(value)) return refuse('shape', 'not an object');
  keysOnly(
    value,
    [
      'kind',
      'modes',
      'units',
      'nodes',
      'parts',
      'prescribed',
      'force',
      'equations',
      'masses',
      'thermal',
    ],
    '',
  );
  const { kind, modes, units, nodes, parts, prescribed, force, equations, masses, thermal } = value;
  if (kind !== 'linear-static' && kind !== 'modal') refuse('shape', 'kind');
  const modal = kind === 'modal';
  if (modal) {
    if (!Number.isInteger(modes) || (modes as number) < 1) refuse('shape', 'modes');
    if ((modes as number) > computeJobShape.modes)
      refuse('too-large', `${modes as number} modes > ${computeJobShape.modes}`);
    if (units !== 'mm') refuse('shape', 'a modal job is in mm');
  } else if (modes !== undefined) refuse('shape', 'modes in a static job');
  if (units !== 'mm' && units !== 'm') refuse('shape', 'units');
  if (!Array.isArray(nodes)) return refuse('shape', 'nodes');
  if (nodes.length % 3 || !nodes.length) refuse('shape', 'nodes is not x, y, z per node');
  const n = nodes.length / 3;
  if (n > limits.nodes) refuse('too-large', `${n} nodes > ${limits.nodes}`);
  if (!nodes.every(finite)) refuse('not-finite', 'nodes');
  if (!Array.isArray(parts) || !parts.length) return refuse('shape', 'parts');
  if (parts.length > computeJobShape.parts)
    refuse('too-large', `${parts.length} parts > ${computeJobShape.parts}`);
  let m = 0;
  const checked = parts.map((part, k): CalculixModel['parts'][number] => {
    if (!isObject(part)) return refuse('shape', `part ${k}`);
    keysOnly(part, ['type', 'elements', 'material'], `part ${k}: `);
    const { type, elements, material } = part;
    if (type !== 'tet4' && type !== 'tet10' && type !== 'wedge15')
      refuse('shape', `part ${k} type`);
    if (!Array.isArray(elements)) return refuse('shape', `part ${k} elements`);
    const npe = calculixNodesPerElement[type as CalculixElementType];
    if (elements.length % npe || !elements.length)
      refuse('shape', `part ${k}: elements is not ${npe} per element`);
    m += elements.length / npe;
    if (m > limits.elements) refuse('too-large', `${m} elements > ${limits.elements}`);
    elements.forEach((p, i) => {
      if (!Number.isInteger(p) || p < 0 || p >= n) refuse('index', `part ${k} element entry ${i}`);
    });
    if (!isObject(material)) return refuse('shape', `part ${k} material`);
    keysOnly(
      material,
      [
        'youngsModulus',
        'poissonsRatio',
        ...(modal ? ['density'] : []),
        ...(thermal !== undefined ? ['expansion'] : []),
      ],
      `part ${k} material: `,
    );
    const E = material.youngsModulus,
      nu = material.poissonsRatio,
      rho = material.density,
      alpha = material.expansion;
    if (thermal !== undefined && !(finite(alpha) && alpha >= 0))
      refuse('material', `part ${k}: expansion ≥ 0`);
    if (!finite(E) || !finite(nu) || !(E > 0) || !(nu > -1 && nu < 0.5))
      refuse('material', `part ${k}: E > 0 and −1 < ν < 0.5`);
    if (modal && !(finite(rho) && rho > 0)) refuse('material', `part ${k}: density > 0`);
    return {
      type: type as CalculixElementType,
      elements: Uint32Array.from(elements as number[]),
      material: {
        youngsModulus: E as number,
        poissonsRatio: nu as number,
        ...(modal ? { density: rho as number } : {}),
        ...(thermal !== undefined ? { expansion: alpha as number } : {}),
      },
    };
  });
  const dof = (d: unknown, what: string) => {
    if (!Number.isInteger(d) || (d as number) < 0 || (d as number) >= 3 * n)
      refuse('index', `${what} DOF`);
    return d as number;
  };
  const pairs = (list: unknown, what: string) => {
    if (!Array.isArray(list)) return refuse('shape', what);
    if (list.length > 3 * n) refuse('too-large', what);
    const seen = new Set<number>();
    return list.map((pair, k): [number, number] => {
      if (!Array.isArray(pair) || pair.length !== 2) return refuse('shape', `${what} ${k}`);
      const [d, x] = pair as unknown[];
      dof(d, `${what} ${k}`);
      if (!finite(x)) refuse('not-finite', `${what} ${k}`);
      if (seen.has(d as number)) refuse('index', `${what} ${k}: DOF ${d} twice`);
      seen.add(d as number);
      return [d as number, x as number];
    });
  };
  const held = pairs(prescribed, 'prescribed');
  if (!held.length) refuse('shape', 'nothing is held');
  if (modal && held.some(([, x]) => x !== 0)) refuse('shape', 'a modal job holds at 0 only');
  const f = new Float64Array(3 * n);
  const loads = pairs(force, 'force');
  if (modal && loads.length) refuse('shape', 'a modal job has no force');
  for (const [d, x] of loads) f[d] = x;
  if (!Array.isArray(equations)) return refuse('shape', 'equations');
  if (equations.length > 3 * n) refuse('too-large', 'equations');
  const fixed = new Set(held.map(([d]) => d));
  const eliminated = new Set<number>();
  const eqs = equations.map((terms, k): [number, number][] => {
    if (!Array.isArray(terms) || terms.length < 2) return refuse('shape', `equation ${k}`);
    if (terms.length > computeJobShape.terms)
      refuse('too-large', `equation ${k}: ${terms.length} terms > ${computeJobShape.terms}`);
    const out = terms.map((term, i): [number, number] => {
      if (!Array.isArray(term) || term.length !== 2)
        return refuse('shape', `equation ${k} term ${i}`);
      const [d, c] = term as unknown[];
      dof(d, `equation ${k} term ${i}`);
      if (!finite(c) || c === 0) refuse('not-finite', `equation ${k} term ${i}: a coefficient ≠ 0`);
      return [d as number, c as number];
    });
    const first = out[0]![0];
    if (fixed.has(first) || eliminated.has(first))
      refuse('index', `equation ${k}: DOF ${first} is held or eliminated already`);
    eliminated.add(first);
    return out;
  });
  // CR5a: point masses, each node once, a mass > 0, in a modal job only.
  let points: [number, number][] = [];
  if (masses !== undefined) {
    if (!modal) refuse('shape', 'masses in a static job');
    if (!Array.isArray(masses)) return refuse('shape', 'masses');
    if (masses.length > n) refuse('too-large', 'masses');
    const seen = new Set<number>();
    points = masses.map((pair, k): [number, number] => {
      if (!Array.isArray(pair) || pair.length !== 2) return refuse('shape', `mass ${k}`);
      const [p, x] = pair as unknown[];
      if (!Number.isInteger(p) || (p as number) < 0 || (p as number) >= n)
        refuse('index', `mass ${k} node`);
      if (!finite(x) || !(x > 0)) refuse('not-finite', `mass ${k}: a mass > 0`);
      if (seen.has(p as number)) refuse('index', `mass ${k}: node ${p} twice`);
      seen.add(p as number);
      return [p as number, x as number];
    });
  }
  // VS11d-3: a static job's temperatures, one finite value ≥ 0 K per node.
  let temperatures: { temperature: Float64Array; reference: number } | undefined;
  if (thermal !== undefined) {
    if (modal) refuse('shape', 'temperatures in a modal job');
    if (!isObject(thermal)) return refuse('shape', 'thermal');
    keysOnly(thermal, ['temperature', 'reference'], 'thermal: ');
    const { temperature, reference } = thermal;
    if (!Array.isArray(temperature) || temperature.length !== n)
      refuse('shape', 'thermal: a temperature per node');
    if (!(temperature as unknown[]).every((t) => finite(t) && t >= 0))
      refuse('not-finite', 'thermal: temperatures ≥ 0 K');
    if (!finite(reference) || reference < 0) refuse('not-finite', 'thermal: reference ≥ 0 K');
    temperatures = {
      temperature: Float64Array.from(temperature as number[]),
      reference: reference as number,
    };
  }
  return {
    nodes: Float64Array.from(nodes as number[]),
    parts: checked,
    ...(temperatures ? { thermal: temperatures } : {}),
    prescribed: new Map(held),
    force: f,
    equations: eqs,
    ...(points.length ? { masses: points } : {}),
    units: units as CalculixUnits,
    ...(modal ? { modes: modes as number } : {}),
  };
}

/**
 * CS4 (docs/cad/construction-site.md, CS-U5): a frame of beam elements, solved on the Host only.
 * Numbers only, as for the other jobs: nodes, element groups with their sections and materials,
 * fixed nodes, nodal forces and gravity.
 */
export interface FrameComputeJob {
  kind: 'frame-static';
  frame: FrameModel;
}

/** Checks a frame job as it arrives; its sizes against `limits` too. */
export function checkFrameJob(
  value: unknown,
  limits: Readonly<SimulationComputeLimits> = referenceComputeLimits,
): FrameModel {
  if (!isObject(value)) return refuse('shape', 'not an object');
  keysOnly(value, ['kind', 'frame'], '');
  if (value.kind !== 'frame-static') refuse('shape', 'kind');
  try {
    return checkFrameModel(value.frame, {
      nodes: limits.nodes,
      elements: limits.elements,
      groups: 2000,
    });
  } catch (e) {
    if (!(e instanceof FrameModelError)) throw e;
    const problem =
      e.problem === 'section' ? 'shape' : (e.problem as Exclude<typeof e.problem, 'section'>);
    return refuse(problem, `frame: ${e.detail}`);
  }
}

/**
 * VS11d-3: checks a transient job as it arrives (from JSON, so anything): its keys, sizes against
 * `limits` and `computeTransientShape`, every number finite, node and element indices in range,
 * amplitudes named in range with increasing times, materials > 0 and temperatures ≥ 0 K. Returns
 * the model `writeCalculixHeat` writes; refuses anything else.
 */
export function checkTransientJob(
  value: unknown,
  limits: Readonly<SimulationComputeLimits> = referenceComputeLimits,
): CalculixHeatModel {
  if (!isObject(value)) return refuse('shape', 'not an object');
  keysOnly(value, ['kind', 'heat'], '');
  const heat = value.heat;
  if (!isObject(heat)) return refuse('shape', 'heat');
  keysOnly(
    heat,
    [
      'nodes',
      'type',
      'elements',
      'material',
      'initialTemperature',
      'time',
      'amplitudes',
      'holds',
      'faces',
      'nodal',
    ],
    'heat: ',
  );
  const numbers = (x: unknown, what: string): number[] => {
    if (!Array.isArray(x)) return refuse('shape', what);
    if (!x.every(finite)) refuse('not-finite', what);
    return x as number[];
  };
  const nodes = numbers(heat.nodes, 'nodes');
  if (!nodes.length || nodes.length % 3) refuse('shape', 'nodes is not x, y, z per node');
  const n = nodes.length / 3;
  if (n > limits.nodes) refuse('too-large', `${n} nodes > ${limits.nodes}`);
  const type = heat.type;
  if (type !== 'tet4' && type !== 'tet10') refuse('shape', 'type');
  const npe = calculixNodesPerElement[type as 'tet4' | 'tet10'];
  const elements = numbers(heat.elements, 'elements');
  if (!elements.length || elements.length % npe)
    refuse('shape', `elements is not ${npe} per element`);
  const m = elements.length / npe;
  if (m > limits.elements) refuse('too-large', `${m} elements > ${limits.elements}`);
  const node = (p: unknown, what: string) => {
    if (!Number.isInteger(p) || (p as number) < 0 || (p as number) >= n) refuse('index', what);
    return p as number;
  };
  elements.forEach((p, i) => node(p, `element entry ${i}`));
  const material = heat.material;
  if (!isObject(material)) return refuse('shape', 'material');
  keysOnly(material, ['conductivity', 'density', 'specificHeat'], 'material: ');
  for (const k of ['conductivity', 'density', 'specificHeat'])
    if (!(finite(material[k]) && (material[k] as number) > 0)) refuse('material', `${k} > 0`);
  const initial = numbers(heat.initialTemperature, 'initialTemperature');
  if (initial.length !== n || !initial.every((t) => t >= 0))
    refuse('shape', 'initialTemperature: one value ≥ 0 K per node');
  const time = heat.time;
  if (!isObject(time)) return refuse('shape', 'time');
  keysOnly(time, ['end', 'step'], 'time: ');
  if (!(finite(time.end) && finite(time.step) && time.end > 0 && time.step > 0))
    refuse('shape', 'time: end and step > 0');
  const steps = Math.max(1, Math.ceil((time.end as number) / (time.step as number) - 1e-9));
  if (steps * n > computeTransientShape.values)
    refuse('too-large', `${steps} steps of ${n} nodes > ${computeTransientShape.values} values`);
  if (!Array.isArray(heat.amplitudes)) return refuse('shape', 'amplitudes');
  if (heat.amplitudes.length > computeTransientShape.amplitudes)
    refuse('too-large', `${heat.amplitudes.length} amplitudes`);
  let points = 0;
  const amplitudes = heat.amplitudes.map((a, k) => {
    if (!isObject(a)) return refuse('shape', `amplitude ${k}`);
    keysOnly(a, ['times', 'factors'], `amplitude ${k}: `);
    const times = numbers(a.times, `amplitude ${k} times`);
    const factors = numbers(a.factors, `amplitude ${k} factors`);
    if (!times.length || times.length !== factors.length)
      refuse('shape', `amplitude ${k}: as many times as factors`);
    points += times.length;
    if (points > computeTransientShape.amplitudePoints) refuse('too-large', 'amplitude points');
    times.forEach((t, i) => {
      if (t < 0 || (i > 0 && !(t > times[i - 1]!)))
        refuse('shape', `amplitude ${k}: times increase from 0`);
    });
    return { times, factors };
  });
  const amplitude = (a: unknown, what: string) => {
    if (a === undefined) return {};
    if (!Number.isInteger(a) || (a as number) < 0 || (a as number) >= amplitudes.length)
      refuse('index', `${what} amplitude`);
    return { amplitude: a as number };
  };
  if (!Array.isArray(heat.holds)) return refuse('shape', 'holds');
  let held = 0;
  const holds = heat.holds.map((h, k) => {
    if (!isObject(h)) return refuse('shape', `hold ${k}`);
    keysOnly(h, ['nodes', 'temperature', 'amplitude'], `hold ${k}: `);
    const list = numbers(h.nodes, `hold ${k} nodes`);
    held += list.length;
    if (held > n) refuse('too-large', 'held nodes');
    list.forEach((p, i) => node(p, `hold ${k} node ${i}`));
    if (!(finite(h.temperature) && h.temperature >= 0))
      refuse('not-finite', `hold ${k} temperature`);
    return {
      nodes: list,
      temperature: h.temperature as number,
      ...amplitude(h.amplitude, `hold ${k}`),
    };
  });
  if (!Array.isArray(heat.faces)) return refuse('shape', 'faces');
  // Each of an element's 4 faces may carry a flux, a film and a radiation (Codex on #1272).
  if (heat.faces.length > 12 * m) refuse('too-large', 'faces');
  const faces = heat.faces.map((f, k): CalculixHeatFace => {
    if (!isObject(f)) return refuse('shape', `face ${k}`);
    const { kind, element, face } = f;
    if (!Number.isInteger(element) || (element as number) < 0 || (element as number) >= m)
      refuse('index', `face ${k} element`);
    if (!Number.isInteger(face) || (face as number) < 0 || (face as number) > 3)
      refuse('index', `face ${k} local face`);
    const at = { element: element as number, face: face as number };
    if (kind === 'flux') {
      keysOnly(f, ['kind', 'element', 'face', 'flux', 'amplitude'], `face ${k}: `);
      if (!finite(f.flux)) refuse('not-finite', `face ${k} flux`);
      return { kind, ...at, flux: f.flux as number, ...amplitude(f.amplitude, `face ${k}`) };
    }
    if (kind === 'film') {
      keysOnly(
        f,
        ['kind', 'element', 'face', 'coefficient', 'ambient', 'amplitude'],
        `face ${k}: `,
      );
      if (!(finite(f.coefficient) && f.coefficient > 0 && finite(f.ambient) && f.ambient >= 0))
        refuse('not-finite', `face ${k}: coefficient > 0, ambient ≥ 0 K`);
      return {
        kind,
        ...at,
        coefficient: f.coefficient as number,
        ambient: f.ambient as number,
        ...amplitude(f.amplitude, `face ${k}`),
      };
    }
    if (kind === 'radiation') {
      keysOnly(f, ['kind', 'element', 'face', 'emissivity', 'ambient'], `face ${k}: `);
      if (
        !(
          finite(f.emissivity) &&
          f.emissivity > 0 &&
          f.emissivity <= 1 &&
          finite(f.ambient) &&
          f.ambient >= 0
        )
      )
        refuse('not-finite', `face ${k}: emissivity in (0, 1], ambient ≥ 0 K`);
      return { kind, ...at, emissivity: f.emissivity as number, ambient: f.ambient as number };
    }
    return refuse('shape', `face ${k} kind`);
  });
  if (!Array.isArray(heat.nodal)) return refuse('shape', 'nodal');
  if (heat.nodal.length > n) refuse('too-large', 'nodal');
  const nodal = heat.nodal.map((c, k) => {
    if (!isObject(c)) return refuse('shape', `nodal ${k}`);
    keysOnly(c, ['node', 'heat', 'amplitude'], `nodal ${k}: `);
    if (!finite(c.heat)) refuse('not-finite', `nodal ${k} heat`);
    return {
      node: node(c.node, `nodal ${k}`),
      heat: c.heat as number,
      ...amplitude(c.amplitude, `nodal ${k}`),
    };
  });
  return {
    nodes: Float64Array.from(nodes),
    type: type as 'tet4' | 'tet10',
    elements: Uint32Array.from(elements),
    material: material as CalculixHeatModel['material'],
    initialTemperature: Float64Array.from(initial),
    time: { end: time.end as number, step: time.step as number },
    amplitudes,
    holds,
    faces,
    nodal,
  };
}

/** VS11d-3: the job of a transient input (`transientCalculixModel`). */
export function transientComputeJob(input: TransientInput): TransientComputeJob {
  const model = transientCalculixModel(input);
  return {
    kind: 'transient-thermal',
    heat: {
      nodes: Array.from(model.nodes),
      type: model.type,
      elements: Array.from(model.elements),
      material: { ...model.material },
      initialTemperature: Array.from(model.initialTemperature),
      time: { ...model.time },
      amplitudes: model.amplitudes.map((a) => ({ times: [...a.times], factors: [...a.factors] })),
      holds: model.holds.map((h) => ({ ...h, nodes: [...h.nodes] })),
      faces: model.faces.map((f) => ({ ...f })),
      nodal: (model.nodal ?? []).map((c) => ({ ...c })),
    },
  };
}

/** The `.inp` of a checked job: the only text the reference Host gives CalculiX. */
export function computeJobInp(
  value: unknown,
  limits: Readonly<SimulationComputeLimits> = referenceComputeLimits,
): { inp: string; nodes: number; units: CalculixUnits } {
  if (isObject(value) && value.kind === 'transient-thermal') {
    const heat = checkTransientJob(value, limits);
    return { inp: writeCalculixHeat(heat), nodes: heat.nodes.length / 3, units: 'mm' };
  }
  if (isObject(value) && value.kind === 'frame-static') {
    const frame = checkFrameJob(value, limits);
    return { inp: writeCalculixFrame(frame), nodes: frame.nodes.length / 3, units: 'mm' };
  }
  const model = checkComputeJob(value, limits);
  return {
    inp: writeCalculixModel(model),
    nodes: model.nodes.length / 3,
    units: model.units,
  };
}

/** A job's state as the Host reports it. */
export type ComputeJobState =
  | { state: 'queued' | 'running'; phase: string; elapsedMs: number }
  | { state: 'done'; elapsedMs: number }
  | { state: 'failed'; message: string }
  | { state: 'cancelled' };

export class ComputeHostError extends Error {
  constructor(
    readonly reason: 'unreachable' | 'refused' | 'failed' | 'cancelled',
    message: string,
  ) {
    super(message);
    this.name = 'ComputeHostError';
  }
}

export interface ComputeRunOptions {
  signal?: AbortSignal;
  onProgress?(state: ComputeJobState): void;
  /** Polling interval (ms). */
  pollMs?: number;
  fetch?: typeof fetch;
}

/**
 * Sends a job to the Host's endpoint, follows it and returns the `.frd` text. Aborting the signal
 * cancels the job on the Host. A Host that cannot be reached, refuses the job or fails it gives a
 * `ComputeHostError` with the reason, so the editor can say why and keep the browser run.
 */
export async function runComputeJob(
  host: SimulationComputeDescriptor,
  job: SimulationComputeJob | FrameComputeJob | AeroJob | CrashJob | TransientComputeJob,
  options: ComputeRunOptions = {},
): Promise<string> {
  const http = options.fetch ?? fetch;
  const { signal } = options;
  /** One request with its body read: a connection lost before the end is `unreachable` too. */
  const call = async (url: string, init: RequestInit = {}) => {
    try {
      const res = await http(url, { ...init, signal });
      return { ok: res.ok, status: res.status, text: await res.text() };
    } catch (e) {
      if (signal?.aborted) throw new ComputeHostError('cancelled', 'cancelled');
      const cause = (e as { cause?: unknown }).cause;
      throw new ComputeHostError(
        'unreachable',
        `${host.label} cannot be reached (${String(e)}${cause ? `: ${String(cause)}` : ''})`,
      );
    }
  };
  const parse = (text: string): Record<string, unknown> => {
    try {
      const v = JSON.parse(text) as unknown;
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as never;
    } catch {
      // Refused below.
    }
    throw new ComputeHostError('failed', `${host.label} answered something else than its JSON`);
  };
  const body = JSON.stringify(job);
  if (body.length > host.limits.bytes)
    throw new ComputeHostError('refused', `the job is larger than ${host.label} takes`);
  const created = await call(`${host.endpoint}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!created.ok)
    throw new ComputeHostError(
      'refused',
      `${host.label} refused the job: ${created.text.slice(0, 500)}`,
    );
  const { id } = parse(created.text);
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(id))
    throw new ComputeHostError('failed', `${host.label} gave no job id`);
  const url = `${host.endpoint}/jobs/${id}`;
  const cancel = () => void http(url, { method: 'DELETE' }).catch(() => undefined);
  signal?.addEventListener('abort', cancel, { once: true });
  let finished = false;
  try {
    for (;;) {
      const res = await call(url);
      if (!res.ok) throw new ComputeHostError('failed', `${host.label}: job ${res.status}`);
      const state = parse(res.text) as unknown as ComputeJobState;
      if (!['queued', 'running', 'done', 'failed', 'cancelled'].includes(state.state))
        throw new ComputeHostError('failed', `${host.label} gave no job state`);
      options.onProgress?.(state);
      if (state.state === 'done') break;
      if (state.state === 'failed') {
        finished = true;
        throw new ComputeHostError('failed', String(state.message).slice(0, 500));
      }
      if (state.state === 'cancelled') {
        finished = true;
        throw new ComputeHostError('cancelled', 'cancelled');
      }
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, options.pollMs ?? 500);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(new ComputeHostError('cancelled', 'cancelled'));
          },
          { once: true },
        );
      });
    }
    const result = await call(`${url}/result`);
    if (!result.ok) throw new ComputeHostError('failed', `${host.label}: result ${result.status}`);
    finished = true;
    return result.text;
  } finally {
    signal?.removeEventListener('abort', cancel);
    // Given up here (lost connection, bad answer): the Host job is not left running.
    if (!finished && !signal?.aborted) cancel();
  }
}

/**
 * CalculiX's `.frd` writes 6 significant digits, so a reaction sum read from it balances the load
 * to about 5e-6 of the reactions' size; the equilibrium check of a Host run allows this much.
 */
export const computeEquilibriumTolerance = 2e-5;

/**
 * The browser solver's result from a Host's `.frd`, for the same checks and display: CalculiX's
 * displacements and nodal stresses, von Mises from them, reactions K u − f at the held DOFs, the
 * applied loads and what each load put on the mesh from `prepared` (the same as the browser's).
 * A direct solve: no iterations, `converged` once the `.frd` passed its checks.
 */
export function elasticResultFromFrd(prepared: ElasticPrepared, frd: FrdResult): ElasticResult {
  const n = frd.displacement.length / 3;
  const reaction = new Float64Array(3 * n);
  for (const d of prepared.prescribed.keys()) reaction[d] = frd.force[d]! - prepared.force[d]!;
  const total = (v: Float64Array) =>
    [0, 1, 2].map((i) => v.reduce((s, x, k) => (k % 3 === i ? s + x : s), 0)) as [
      number,
      number,
      number,
    ];
  const vonMises = new Float64Array(n);
  for (let p = 0; p < n; p++) vonMises[p] = vonMisesOf(frd.stress, p * 6);
  return {
    displacement: frd.displacement,
    stress: frd.stress,
    vonMises,
    reaction,
    appliedTotal: total(prepared.force),
    reactionTotal: total(reaction),
    loadChecks: prepared.loadChecks,
    constrainedNodes: prepared.constrainedNodes,
    iterations: 0,
    residual: 0,
    converged: true,
  };
}

/**
 * Solves a study on a compute Host: the same checks and mapping as the browser (`prepareElastic`,
 * which throws `ElasticError`), the job, the run, and the `.frd` read in full. A Host failure is
 * a `ComputeHostError`; a result that does not fit is `FrdError` (`result-invalid`).
 */
export async function solveOnHost(
  host: SimulationComputeDescriptor,
  input: ElasticInput,
  options: ComputeRunOptions = {},
): Promise<ElasticResult> {
  const prepared = prepareElastic(input);
  const text = await runComputeJob(
    host,
    computeJobOf(input.mesh, input.material, prepared, 'mm', input.thermal),
    options,
  );
  return elasticResultFromFrd(prepared, readCalculixFrd(text, input.mesh.nodes.length / 3));
}

/**
 * VS11d-3: a transient heat study on a compute Host: the browser's checks and mapping
 * (`transientCalculixModel`, which throws `ElasticError` and refuses θ ≠ 1 and radiation between
 * faces), the job, every step's temperatures read back (`readCalculixTemperatures`, `FrdError`
 * when they do not fit) and replayed through the browser's equations, which give the run its
 * history, heats, balance and `replayResidual`.
 */
export async function solveTransientOnHost(
  host: SimulationComputeDescriptor,
  input: TransientInput,
  options: ComputeRunOptions = {},
): Promise<TransientResult> {
  const job = transientComputeJob(input);
  const n = job.heat.nodes.length / 3;
  const text = await runComputeJob(host, job, options);
  const { times, temperatures } = readCalculixTemperatures(text, n);
  const { end, step } = job.heat.time;
  const steps = Math.max(1, Math.ceil(end / step - 1e-9));
  const expected = Array.from({ length: steps }, (_, s) =>
    s + 1 === steps ? end : (s + 1) * step,
  );
  // The `.frd` gives times to about 10 digits.
  if (
    times.length !== steps ||
    times.some((t, s) => Math.abs(t - expected[s]!) > 1e-6 * Math.max(1, expected[s]!))
  )
    throw new FrdError(
      'structure',
      `${times.length} steps at ${times[0]}…${times.at(-1)} s, not ${steps} to ${end} s`,
    );
  // The replay checks the equations sent: CalculiX's capacity rule (Codex on #1272).
  return solveTransientThermal({ ...input, replay: temperatures, capacityRule: 'conduction' });
}

/**
 * R3j-5a: a shell study on a compute Host: the browser's checks and mapping (`prepareShell`, which
 * throws `ElasticError`), the shell as 15-node wedges (`expandShell`, which refuses what the
 * wedges cannot carry with `host-shell`), the run, and the `.frd` folded back onto the shell.
 */
export async function solveShellOnHost(
  host: SimulationComputeDescriptor,
  input: ShellInput,
  options: ComputeRunOptions = {},
): Promise<ShellResult> {
  const prepared = prepareShell(input);
  const expansion = expandShell(input.mesh);
  const model = expandShellStudy(input.mesh, expansion, input.material, prepared);
  const text = await runComputeJob(host, computeJobOfModel(model), options);
  return shellResultFromFrd(
    input.mesh,
    expansion,
    prepared,
    readCalculixFrd(text, expansion.nodes.length / 3),
  );
}

/**
 * R3j-5b: bonded bodies on a compute Host: the browser's checks (`bondedHostModel`, which throws
 * `ElasticError` as `solveBonded` does), one solid model with the bonds as `*EQUATION`s, the run,
 * and the `.frd` read back per part.
 */
export async function solveBondedOnHost(
  host: SimulationComputeDescriptor,
  input: BondedInput,
  options: ComputeRunOptions = {},
): Promise<BondedResult> {
  const model = bondedHostModel(input);
  const text = await runComputeJob(host, computeJobOfModel(model.model), options);
  return bondedResultFromFrd(input, model, readCalculixFrd(text, model.model.nodes.length / 3));
}

/**
 * R3j-5c: what the modal checks allow for a Host's modes: the `.frd`'s 6 significant digits leave
 * about 1e-6 on the Rayleigh quotients and K-orthogonality (`calculixModalSummary`).
 */
export const computeModalTolerance = 1e-4;

/**
 * R3j-5c: a solid's modal study on a compute Host: the browser's refusals (`modalHostModel`),
 * CalculiX's `*FREQUENCY`, and the modes read in full (`readCalculixModes`).
 */
export async function solveModalOnHost(
  host: SimulationComputeDescriptor,
  input: ModalInput,
  options: ComputeRunOptions = {},
): Promise<ModalResult> {
  const model = modalHostModel(input);
  const text = await runComputeJob(host, computeJobOfModel(model.model), options);
  return modalResultFromFrd(
    input,
    model,
    readCalculixModes(text, model.model.nodes.length / 3, calculixModeCount(model.model)),
  );
}

/** R3j-5c: a shell's modal study on a compute Host, as its 15-node wedges. */
export async function solveShellModalOnHost(
  host: SimulationComputeDescriptor,
  input: ShellModalInput,
  options: ComputeRunOptions = {},
): Promise<ShellModalResult> {
  const model = shellModalHostModel(input);
  const text = await runComputeJob(host, computeJobOfModel(model.model), options);
  return shellModalResultFromFrd(
    input,
    model,
    readCalculixModes(text, model.model.nodes.length / 3, calculixModeCount(model.model)),
  );
}

/** R3j-5c: bonded bodies' modal study on a compute Host, the bonds as `*EQUATION`s. */
export async function solveBondedModalOnHost(
  host: SimulationComputeDescriptor,
  input: BondedModalInput,
  options: ComputeRunOptions = {},
): Promise<BondedModalResult> {
  const model = bondedModalHostModel(input);
  const text = await runComputeJob(host, computeJobOfModel(model.model), options);
  return bondedModalResultFromFrd(
    input,
    model,
    readCalculixModes(text, model.model.nodes.length / 3, calculixModeCount(model.model)),
  );
}

/**
 * CS4: a frame on a compute Host: checked here first (`FrameModelError`), run, and its `.frd` read
 * back onto the frame's nodes and elements (`FrdError` when it does not fit).
 */
export async function solveFrameOnHost(
  host: SimulationComputeDescriptor,
  frame: FrameModel,
  options: ComputeRunOptions = {},
): Promise<FrameResult> {
  const checked = checkFrameModel(frame);
  const text = await runComputeJob(host, { kind: 'frame-static', frame: checked }, options);
  return readCalculixFrame(checked, text);
}

/**
 * VS4b: a wind-tunnel job on a compute Host that runs them (`aero` in its descriptor): the job,
 * the run, and its JSON result checked (finite coefficients, a history, the surface samples in
 * step). A Host without a wind tunnel is `refused` before anything is sent.
 */
export async function solveAeroOnHost(
  host: SimulationComputeDescriptor,
  job: AeroJob,
  options: ComputeRunOptions = {},
): Promise<AeroHostResult> {
  if (!host.aero) throw new ComputeHostError('refused', `${host.label} has no wind tunnel`);
  const text = await runComputeJob(host, job, { pollMs: 2000, ...options });
  const bad = (what: string): never => {
    throw new ComputeHostError('failed', `${host.label} sent a wind-tunnel result without ${what}`);
  };
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return bad('JSON');
  }
  if (typeof v !== 'object' || v === null) return bad('an object');
  for (const k of ['cd', 'cl', 'cs', 'clFront', 'clRear'])
    if (typeof v[k] !== 'number' || !Number.isFinite(v[k])) bad(`a finite ${k}`);
  const numbers = (k: string) => {
    const a = v[k];
    if (!Array.isArray(a) || !a.every((x) => typeof x === 'number' && Number.isFinite(x)))
      bad(`its ${k} as numbers`);
    return a as number[];
  };
  const points = numbers('points');
  const cp = numbers('cp');
  const cf = numbers('cf');
  const htc = numbers('htc');
  if (points.length !== 3 * cp.length || cf.length !== cp.length || htc.length !== cp.length)
    bad('surface samples that line up');
  if (!Array.isArray(v.history)) bad('a history');
  return { ...(v as unknown as AeroHostResult), points, cp, cf, htc };
}

/**
 * VS8a: a crash run on a compute Host that runs them (`crash` in its descriptor): the explicit
 * model and settings as numbers, the run followed (`onTime` gets the solved time from the Host's
 * phase), and its result read back into typed arrays. A Host without crash runs is `refused`
 * before anything is sent.
 */
export async function solveCrashOnHost(
  host: SimulationComputeDescriptor,
  model: ExplicitModel,
  settings: ExplicitSettings,
  options: ComputeRunOptions & { onTime?(time: number, endTime: number): void } = {},
): Promise<ExplicitResult> {
  if (!host.crash) throw new ComputeHostError('refused', `${host.label} runs no crash studies`);
  const { onTime, ...rest } = options;
  const text = await runComputeJob(host, crashJobOf(model, settings), {
    pollMs: 1000,
    ...rest,
    onProgress: (state) => {
      rest.onProgress?.(state);
      const m = state.state === 'running' ? /^solving (\S+) of (\S+) s$/.exec(state.phase) : null;
      if (m && Number.isFinite(Number(m[1])) && Number.isFinite(Number(m[2])))
        onTime?.(Number(m[1]), Number(m[2]));
    },
  });
  try {
    return readCrashResult(text);
  } catch (e) {
    throw new ComputeHostError('failed', `${host.label}: ${(e as Error).message}`);
  }
}
