import {
  ElasticError,
  frdRounding,
  nodalHeatFlux,
  solveElastic,
  solveTransientThermal,
  type ElasticConstraint,
  type ElasticInput,
  type ElasticResult,
  type FemMesh,
  type TransientInput,
  type TransientCondition,
  type TransientResult,
} from '@editor-platform/geometry-fem';
import type {
  SimulationConstraint,
  SimulationLoad,
  SimulationMaterial,
  SimulationMetric,
  SimulationTransientStudy,
  RunCheck,
} from '@editor-platform/simulation-core';
import { ConditionRefusal, solidConditions } from './run-conditions';
import { thermalFluxMetric } from './run';

/**
 * VS11d (docs/cad/vehicle-simulation.md, VS11): a transient thermal run's fields on the finest
 * level: the kept temperature fields and their times, the history of each step, and with thermal
 * stress the stress of the last field.
 */
export interface TransientRunFields {
  kind: 'transient-thermal';
  mesh: FemMesh;
  /** s, from 0. */
  times: number[];
  /** K per node at each kept time. */
  temperatures: Float64Array[];
  history: TransientResult['history'];
  /** The last field's heat flux magnitude (mW/mm²) per node. */
  fluxMagnitude: Float64Array;
  /** With thermal stress: σ (xx yy zz xy yz zx, MPa), von Mises and displacement at the end. */
  stress?: { displacement: Float64Array; stress: Float64Array; vonMises: Float64Array };
}

/** The energy balance a transient run passes with, relative to the largest energy it moves. */
export const transientBalanceTolerance = 1e-6;
/** VS11d (Codex on #1264): the roundoff allowed of the stored energy, relative to Σ ρ c V |T|. */
export const transientRoundoff = 1e-10;

/**
 * VS11d-3: a transient study solved on a compute Host: the heat (`solveTransientOnHost`, replayed
 * through the browser's equations) and the thermal stress (`solveOnHost` with `thermal`), with
 * the step residual and the energy balance its results pass with.
 */
export interface TransientRemote {
  name: string;
  solveTransient(input: TransientInput): Promise<TransientResult>;
  solve(input: ElasticInput): Promise<ElasticResult>;
  residual: number;
  balance: number;
}

type TargetsOf = (owner: string, kind: 'face' | 'edge') => number[];

/** The study's items as `solveTransientThermal` conditions (temperatures first, then loads). */
export function transientConditions(
  loads: readonly SimulationLoad[],
  temperatures: readonly SimulationConstraint[],
  of: TargetsOf,
): TransientCondition[] {
  return [
    ...temperatures.map((c): TransientCondition => {
      if (c.kind !== 'temperature') throw new Error('not a temperature');
      return {
        kind: 'temperature',
        faces: of(c.id, 'face'),
        edges: of(c.id, 'edge'),
        temperature: c.temperature,
        ...(c.amplitude ? { amplitude: c.amplitude } : {}),
      };
    }),
    ...loads.map((l): TransientCondition => {
      const faces = of(l.id, 'face');
      if (l.kind === 'heat-flux')
        return {
          kind: 'heat-flux',
          faces,
          flux: l.flux,
          ...(l.amplitude ? { amplitude: l.amplitude } : {}),
        };
      if (l.kind === 'convection')
        return {
          kind: 'convection',
          faces,
          coefficient: l.coefficient,
          ambient: l.ambient,
          ...(l.amplitude ? { amplitude: l.amplitude } : {}),
        };
      if (l.kind === 'radiation')
        return { kind: 'radiation', faces, emissivity: l.emissivity, ambient: l.ambient };
      if (l.kind === 'enclosure') return { kind: 'enclosure', faces, emissivity: l.emissivity };
      throw new Error(`a transient study does not take a ${l.kind} load`);
    }),
  ];
}

export type TransientLevel =
  | {
      metrics: Partial<Record<SimulationMetric, number>>;
      checks: RunCheck[];
      fields: TransientRunFields;
    }
  | { failure: { code: 'solve' | 'material-missing'; detail: string } };

/**
 * Solves one level of a transient study on its mesh and makes its checks (but `mapping` and
 * `quality`, which the caller has): `load` (each face item's mesh area against the shape's),
 * `solver` (every linear and Newton solve converged), `equilibrium` (stored energy against the
 * heat put in over the run).
 */
export async function runTransientLevel(input: {
  mesh: FemMesh;
  study: SimulationTransientStudy;
  material: SimulationMaterial;
  loads: readonly SimulationLoad[];
  constraints: readonly SimulationConstraint[];
  of: TargetsOf;
  measures: {
    faceAreas: ArrayLike<number>;
    faceVectorAreas: ArrayLike<number>;
    edgeLengths: ArrayLike<number>;
  };
  areaTolerance: number;
  /** VS11d-3: solve on a compute Host instead of the browser. */
  remote?: TransientRemote;
}): Promise<TransientLevel> {
  const remote = input.remote;
  const { mesh, study, material, loads, of } = input;
  const t = study.transient;
  if (material.conductivity === undefined || material.specificHeat === undefined)
    return {
      failure: {
        code: 'material-missing',
        detail: `${material.name} needs a conductivity and a specific heat`,
      },
    };
  if (t.stress && material.expansion === undefined)
    return {
      failure: { code: 'material-missing', detail: `${material.name} has no thermal expansion` },
    };
  const temperatures = input.constraints.filter((c) => c.kind === 'temperature');
  const structural = input.constraints.filter((c) => c.kind !== 'temperature');
  let r: TransientResult;
  try {
    const heat: TransientInput = {
      mesh,
      material: {
        conductivity: material.conductivity,
        density: material.density,
        specificHeat: material.specificHeat,
      },
      conditions: transientConditions(loads, temperatures, of),
      initialTemperature: t.initialTemperature,
      time: { end: t.endS, step: t.stepS, theta: t.theta },
      output: { every: t.outputEvery },
      solver: study.solver,
      ...(t.enclosure ? { enclosure: t.enclosure } : {}),
    };
    r = remote ? await remote.solveTransient(heat) : solveTransientThermal(heat);
  } catch (e) {
    if (e instanceof ElasticError)
      return { failure: { code: 'solve', detail: `${e.problem}: ${e.detail}` } };
    throw e;
  }
  const last = r.temperatures.at(-1)!;
  const { fluxMagnitude } = nodalHeatFlux(mesh, material.conductivity, last);
  let maxQ = 0;
  for (const q of fluxMagnitude) maxQ = Math.max(maxQ, q);
  let maxT = -Infinity;
  for (const v of r.history.maxTemperature) maxT = Math.max(maxT, v);
  let maxAbsT = 0;
  for (let s = 0; s < r.history.time.length; s++)
    maxAbsT = Math.max(
      maxAbsT,
      Math.abs(r.history.maxTemperature[s]!),
      Math.abs(r.history.minTemperature[s]!),
    );
  // As the steady path (Codex on #1264): a flux at the size of the gradient's own roundoff is 0,
  // so a body that moves no heat compares equal on every level.
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let p = 0; p < mesh.nodes.length; p += 3)
    for (let d = 0; d < 3; d++) {
      lo[d] = Math.min(lo[d]!, mesh.nodes[p + d]!);
      hi[d] = Math.max(hi[d]!, mesh.nodes[p + d]!);
    }
  maxQ = thermalFluxMetric(maxQ, {
    conductivity: material.conductivity,
    diagonal: Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!),
    maxAbsTemperature: maxAbsT,
  });

  const items = [...temperatures, ...loads];
  const bad = items.flatMap((item, i) => {
    if (item.kind === 'temperature')
      return r.constrainedNodes[i] ? [] : [`${item.id} holds no node`];
    const area = of(item.id, 'face').reduce((s, f) => s + input.measures.faceAreas[f]!, 0);
    const change = Math.abs(r.conditionAreas[i]! - area) / Math.max(area, 1e-300);
    return change <= input.areaTolerance
      ? []
      : [`${item.id} area: ${r.conditionAreas[i]} mm² for ${area} mm²`];
  });
  // The stored energy 1ᵀ C T is a sum over the whole body: its roundoff (about 1e-14 of it) is
  // allowed, with a margin, so a body that moves no heat passes; any sizeable imbalance still fails.
  // A Host's fields come back with the .frd's 6 digits: the stored energy is only known to that
  // rounding of every temperature (Codex on #1272).
  const roundoff = (remote ? frdRounding : transientRoundoff) * r.heatCapacity * maxAbsT;
  const balanced =
    r.balance <= Math.max((remote?.balance ?? transientBalanceTolerance) * r.energyScale, roundoff);
  // A Host's temperatures, replayed: each step solves the browser's equations to the residual.
  const replayed = r.replayResidual === undefined || r.replayResidual <= remote!.residual;
  const metrics: Partial<Record<SimulationMetric, number>> = {
    'max-temperature': maxT,
    'max-heat-flux': maxQ,
  };
  const checks: RunCheck[] = [
    {
      name: 'load',
      pass: bad.length === 0,
      detail: bad.length ? bad.join('; ') : `${items.length} conditions applied`,
    },
    {
      name: 'solver',
      pass: r.converged && replayed,
      detail: remote
        ? `${r.history.time.length - 1} steps by CalculiX on ${remote.name}, step residual in the browser's equations ${r.replayResidual} (≤ ${remote.residual})`
        : `${r.history.time.length - 1} steps, ${r.iterations} PCG iterations, Newton ≤ ${r.newtonIterations}, residual ≤ ${r.residual}`,
    },
    {
      name: 'equilibrium',
      pass: balanced,
      detail: `energy balance ${r.balance} mJ of ${r.energyScale} mJ (${items.map((x, i) => `${x.id} ${r.conditionHeat[i]} mJ`).join(', ')})`,
    },
  ];
  const fields: TransientRunFields = {
    kind: 'transient-thermal',
    mesh,
    times: r.times,
    temperatures: r.temperatures,
    history: r.history,
    fluxMagnitude,
  };
  if (t.stress) {
    let constraints: ElasticConstraint[];
    try {
      ({ constraints } = solidConditions([], structural, of, input.measures as never));
    } catch (e) {
      if (e instanceof ConditionRefusal) return { failure: { code: 'solve', detail: e.message } };
      throw e;
    }
    try {
      const stressInput: ElasticInput = {
        mesh,
        material,
        loads: [],
        constraints,
        thermal: {
          temperature: last,
          reference: t.stress.reference,
          expansion: material.expansion!,
        },
        solver: study.solver,
      };
      const s = remote ? await remote.solve(stressInput) : solveElastic(stressInput);
      let vm = 0;
      for (const v of s.vonMises) vm = Math.max(vm, v);
      metrics['max-von-mises'] = vm;
      fields.stress = { displacement: s.displacement, stress: s.stress, vonMises: s.vonMises };
      if (!s.converged) {
        checks[1]!.pass = false;
        checks[1]!.detail += `; thermal stress PCG did not converge (${s.residual})`;
      }
    } catch (e) {
      if (e instanceof ElasticError)
        return { failure: { code: 'solve', detail: `thermal stress: ${e.problem}: ${e.detail}` } };
      throw e;
    }
  }
  return { metrics, checks, fields };
}
