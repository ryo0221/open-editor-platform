import {
  calculixElementName,
  calculixNodesPerElement,
  calculixNumber,
  FrdError,
  frdReadLimits,
  scanFrd,
  type FrdReadLimits,
} from './calculix';
import type { Amplitude } from './transient';

/**
 * VS11d-3 (docs/cad/vehicle-simulation.md, VS11): a transient heat transfer model for CalculiX
 * (`*HEAT TRANSFER, DIRECT`, backward Euler in fixed steps), in the browser's units (mm, t, s, mW,
 * K). The conditions are those of `solveTransientThermal` but the enclosure: held nodal
 * temperatures, and on element faces a heat flux (`*DFLUX`), a film (`*FILM`) and radiation to the
 * surroundings (`*RADIATE`), each with an optional amplitude.
 */
export interface CalculixHeatModel {
  /** x, y, z per node (mm). */
  nodes: ArrayLike<number>;
  type: 'tet4' | 'tet10';
  elements: ArrayLike<number>;
  material: { conductivity: number; density: number; specificHeat: number };
  /** K per node at t = 0. */
  initialTemperature: ArrayLike<number>;
  /** s: the run's end and its fixed step (the last step ends at `end`). */
  time: { end: number; step: number };
  /** The amplitudes the conditions name by index (piecewise linear, held at the ends). */
  amplitudes: readonly Amplitude[];
  /** Held temperatures (K), each on its nodes. */
  holds: readonly { nodes: readonly number[]; temperature: number; amplitude?: number }[];
  /** Face conditions on element faces (`face` is the local face 0–3 of `localFaces`). */
  faces: readonly CalculixHeatFace[];
  /** Concentrated nodal heats (mW, `*CFLUX`), each with an optional amplitude. */
  nodal?: readonly { node: number; heat: number; amplitude?: number }[];
}
export type CalculixHeatFace =
  | { kind: 'flux'; element: number; face: number; flux: number; amplitude?: number }
  | {
      kind: 'film';
      element: number;
      face: number;
      coefficient: number;
      ambient: number;
      amplitude?: number;
    }
  | { kind: 'radiation'; element: number; face: number; emissivity: number; ambient: number };

/** σ in mW/(mm²·K⁴). */
const sigma = 5.670374419e-11;
/**
 * The CalculiX face label of each local face (`localFaces`, the face opposite corner k): C3D4 and
 * C3D10 faces are 1: 1-2-3, 2: 1-4-2, 3: 2-4-3, 4: 3-4-1.
 */
export const calculixTetFace: readonly number[] = Object.freeze([3, 4, 2, 1]);

/** The `.inp` of a heat transfer model; it asks for the nodal temperature (NT) at every step. */
export function writeCalculixHeat(model: CalculixHeatModel): string {
  const n = model.nodes.length / 3;
  if (!Number.isInteger(n) || n < 1) throw new RangeError('nodes');
  const npe = calculixNodesPerElement[model.type];
  const m = model.elements.length / npe;
  if (!Number.isInteger(m) || m < 1) throw new RangeError('elements');
  const { conductivity, density, specificHeat } = model.material;
  for (const [name, v] of [
    ['conductivity', conductivity],
    ['density', density],
    ['specific heat', specificHeat],
  ] as const)
    if (!(v > 0) || !Number.isFinite(v)) throw new RangeError(`${name} > 0`);
  if (model.initialTemperature.length !== n) throw new RangeError('initial temperature length');
  const { end, step } = model.time;
  if (!(end > 0 && step > 0) || !Number.isFinite(end) || !Number.isFinite(step))
    throw new RangeError('time');
  const amp = (a: number | undefined) => {
    if (a === undefined) return '';
    if (!Number.isInteger(a) || a < 0 || a >= model.amplitudes.length)
      throw new RangeError(`amplitude ${a}`);
    return `A${a + 1}`;
  };
  const node = (p: number) => {
    if (!Number.isInteger(p) || p < 0 || p >= n) throw new RangeError(`node ${p}`);
    return p + 1;
  };
  const face = (f: CalculixHeatFace) => {
    if (!Number.isInteger(f.element) || f.element < 0 || f.element >= m)
      throw new RangeError(`element ${f.element}`);
    const label = calculixTetFace[f.face];
    if (label === undefined) throw new RangeError(`face ${f.face}`);
    return { element: f.element + 1, label };
  };

  const out: string[] = [
    '** editor-platform transient heat transfer (VS11d-3)',
    '*NODE, NSET=NALL',
  ];
  for (let p = 0; p < n; p++)
    out.push(
      `${p + 1}, ${calculixNumber(model.nodes[3 * p]!)}, ${calculixNumber(model.nodes[3 * p + 1]!)}, ${calculixNumber(model.nodes[3 * p + 2]!)}`,
    );
  out.push(`*ELEMENT, TYPE=${calculixElementName[model.type]}, ELSET=EALL`);
  for (let e = 0; e < m; e++) {
    const ids = [e + 1];
    for (let a = 0; a < npe; a++) ids.push(node(model.elements[e * npe + a]!));
    out.push(ids.join(', '));
  }
  out.push(
    '*MATERIAL, NAME=M1',
    '*CONDUCTIVITY',
    calculixNumber(conductivity),
    '*DENSITY',
    calculixNumber(density),
    '*SPECIFIC HEAT',
    calculixNumber(specificHeat),
    '*SOLID SECTION, ELSET=EALL, MATERIAL=M1',
    `*PHYSICAL CONSTANTS, ABSOLUTE ZERO=0, STEFAN BOLTZMANN=${calculixNumber(sigma)}`,
  );
  model.amplitudes.forEach((a, k) => {
    if (a.times.length !== a.factors.length || !a.times.length)
      throw new RangeError(`amplitude ${k}`);
    out.push(`*AMPLITUDE, NAME=A${k + 1}`);
    // At most 4 time–value pairs on a line.
    for (let i = 0; i < a.times.length; i += 4)
      out.push(
        a.times
          .slice(i, i + 4)
          .map((t, j) => `${calculixNumber(t)}, ${calculixNumber(a.factors[i + j]!)}`)
          .join(', '),
      );
  });
  out.push('*INITIAL CONDITIONS, TYPE=TEMPERATURE');
  for (let p = 0; p < n; p++) {
    const T = model.initialTemperature[p]!;
    if (!(T >= 0) || !Number.isFinite(T)) throw new RangeError(`initial temperature ${p}`);
    out.push(`${p + 1}, ${calculixNumber(T)}`);
  }
  const steps = Math.max(1, Math.ceil(end / step - 1e-9));
  out.push(
    `*STEP, INC=${steps + 10}`,
    '*HEAT TRANSFER, DIRECT',
    `${calculixNumber(step)}, ${calculixNumber(end)}`,
  );
  for (const h of model.holds) {
    if (!(h.temperature >= 0) || !Number.isFinite(h.temperature))
      throw new RangeError('held temperature');
    const a = amp(h.amplitude);
    out.push(`*BOUNDARY${a ? `, AMPLITUDE=${a}` : ''}`);
    for (const p of h.nodes) out.push(`${node(p)}, 11, 11, ${calculixNumber(h.temperature)}`);
  }
  // One keyword block per kind and amplitude, in the order they come.
  const groups = new Map<string, string[]>();
  const add = (key: string, line: string) => {
    const g = groups.get(key);
    if (g) g.push(line);
    else groups.set(key, [line]);
  };
  for (const f of model.faces) {
    const { element, label } = face(f);
    if (f.kind === 'flux') {
      if (!Number.isFinite(f.flux)) throw new RangeError('flux');
      const a = amp(f.amplitude);
      add(
        `*DFLUX${a ? `, AMPLITUDE=${a}` : ''}`,
        `${element}, S${label}, ${calculixNumber(f.flux)}`,
      );
    } else if (f.kind === 'film') {
      if (!(f.coefficient > 0) || !(f.ambient >= 0) || !Number.isFinite(f.coefficient + f.ambient))
        throw new RangeError('film');
      const a = amp(f.amplitude);
      add(
        `*FILM${a ? `, FILM AMPLITUDE=${a}` : ''}`,
        `${element}, F${label}, ${calculixNumber(f.ambient)}, ${calculixNumber(f.coefficient)}`,
      );
    } else {
      if (
        !(f.emissivity > 0 && f.emissivity <= 1) ||
        !(f.ambient >= 0) ||
        !Number.isFinite(f.ambient)
      )
        throw new RangeError('radiation');
      add(
        '*RADIATE',
        `${element}, R${label}, ${calculixNumber(f.ambient)}, ${calculixNumber(f.emissivity)}`,
      );
    }
  }
  for (const c of model.nodal ?? []) {
    if (!Number.isFinite(c.heat)) throw new RangeError('nodal heat');
    const a = amp(c.amplitude);
    add(`*CFLUX${a ? `, AMPLITUDE=${a}` : ''}`, `${node(c.node)}, 11, ${calculixNumber(c.heat)}`);
  }
  for (const [key, lines] of groups) {
    out.push(key);
    for (const l of lines) out.push(l);
  }
  out.push('*NODE FILE, FREQUENCY=1', 'NT', '*END STEP', '');
  return out.join('\n');
}

/**
 * VS11d-3: every nodal temperature field (NDTEMP) of a heat transfer `.frd` on `nodes` nodes, in
 * order, with the step time of each from its frame header. Fields out of time order, a missing
 * time and everything `readCalculixFrd` refuses are refused.
 */
export function readCalculixTemperatures(
  text: string,
  nodes: number,
  limits: Readonly<FrdReadLimits> = frdReadLimits,
): { times: number[]; temperatures: Float64Array[] } {
  const times: number[] = [];
  const temperatures: Float64Array[] = [];
  for (const b of scanFrd(text, nodes, limits)) {
    if (b.name !== 'NDTEMP') continue;
    // `  100CL  101 1.000000000E+01 …`: the frame's step time after the set number.
    const raw = b.frame.slice(12, 24);
    const t = Number(raw);
    if (!/^ *[-+]?\d+(\.\d*)?([Ee][-+]?\d+)?$/.test(raw) || !Number.isFinite(t))
      throw new FrdError('format', `frame time ${JSON.stringify(raw)}`);
    if (times.length && !(t > times.at(-1)!))
      throw new FrdError('structure', `frame at ${t} s after ${times.at(-1)} s`);
    times.push(t);
    temperatures.push(b.data);
  }
  if (!temperatures.length) throw new FrdError('missing', 'no NDTEMP block');
  return { times, temperatures };
}
