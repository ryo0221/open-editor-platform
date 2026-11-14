import {
  simulationLimits,
  type SimulationMeshSettings,
  type SimulationMetric,
  type SimulationRunCheckName,
  type SimulationStudy,
  type SimulationStudyKind,
} from './model';

/**
 * R3d-2b: the mesh settings of each convergence level (docs/cad/r3-analysis.md, 既知解のfixture):
 * level 0 is the document's, and each next level multiplies every size by 1/√2. The count is a
 * whole number from 1 to `simulationLimits.convergenceLevels`; anything else is a RangeError.
 */
export function convergenceLevelSettings(
  mesh: SimulationMeshSettings,
  levels: number,
): SimulationMeshSettings[] {
  if (!Number.isInteger(levels) || levels < 1 || levels > simulationLimits.convergenceLevels)
    throw new RangeError(`convergence levels must be 1–${simulationLimits.convergenceLevels}`);
  return Array.from({ length: levels }, (_, k) => {
    const f = Math.SQRT1_2 ** k;
    return {
      ...mesh,
      size: mesh.size * f,
      minSize: mesh.minSize * f,
      local: mesh.local.map((l) => ({ ...l, size: l.size * f })),
    };
  });
}

/** One check of a run, by name, with what it measured. */
export interface RunCheck {
  name: SimulationRunCheckName;
  pass: boolean;
  detail: string;
}

/** Every one of these must be present and pass for `verified` (状態の決め方). */
export const runCheckNames: readonly RunCheck['name'][] = Object.freeze([
  'mapping',
  'load',
  'quality',
  'solver',
  'equilibrium',
]);
/** R3g: the checks each kind of study needs for `verified`. */
export const studyCheckNames: Readonly<Record<SimulationStudyKind, readonly RunCheck['name'][]>> =
  Object.freeze({
    'linear-static': runCheckNames,
    modal: Object.freeze(['mapping', 'mass', 'quality', 'solver', 'orthogonality'] as const),
    thermal: runCheckNames,
    aero: Object.freeze(['surface', 'solver'] as const),
  });

export type RunStatus = 'verified' | 'reference' | 'failed';

export interface StudyStatusInput {
  study: Pick<SimulationStudy, 'convergence'> & { kind?: SimulationStudyKind };
  /**
   * A failure that leaves no result (mapping ambiguous or missing, rigid-body mode, meshing or
   * preparation failure): the run is `failed` whatever else.
   */
  failure?: string;
  /** The finest level's checks. */
  checks: RunCheck[];
  /** The metrics of each level that was solved, coarse first. */
  levels: Partial<Record<SimulationMetric, number>>[];
}

export interface StudyStatus {
  status: RunStatus;
  reasons: string[];
  /** Per metric, the relative change between the last two levels. */
  changes: Partial<Record<SimulationMetric, number>>;
}

/**
 * The state of a study's result (状態の決め方): `failed` without a result; `verified` when every
 * check of `runCheckNames` is present and passes and, over at least two of the study's levels, each
 * metric changed by at most the tolerance between the last two; otherwise `reference` with the reasons, shown marked and never used by R4.
 */
export function studyStatus(input: StudyStatusInput): StudyStatus {
  if (input.failure) return { status: 'failed', reasons: [input.failure], changes: {} };
  const reasons: string[] = [];
  for (const c of input.checks) if (!c.pass) reasons.push(`${c.name}: ${c.detail}`);
  for (const name of studyCheckNames[input.study.kind ?? 'linear-static'])
    if (!input.checks.some((c) => c.name === name)) reasons.push(`${name}: not checked`);
  const { levels, metrics, tolerance } = input.study.convergence;
  const changes: StudyStatus['changes'] = {};
  // VS4a: a wind tunnel's coefficients are for reference in V1, whatever the checks.
  if (input.study.kind === 'aero') reasons.push('aero: wind-tunnel results are for reference');
  if (input.levels.length < levels)
    reasons.push(`convergence: ${input.levels.length} of ${levels} levels solved`);
  // One level cannot show mesh convergence, even when the study asks for only one.
  if (input.levels.length < 2) reasons.push('convergence: not confirmed with fewer than 2 levels');
  else {
    const [before, last] = input.levels.slice(-2) as [
      StudyStatusInput['levels'][number],
      StudyStatusInput['levels'][number],
    ];
    for (const m of metrics) {
      const a = before[m],
        b = last[m];
      if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) {
        reasons.push(`convergence: ${m} not measured on the last two levels`);
        continue;
      }
      const change = a === b ? 0 : Math.abs(b - a) / Math.max(Math.abs(a), Math.abs(b));
      changes[m] = change;
      if (!(change <= tolerance))
        reasons.push(
          `convergence: ${m} changed ${(change * 100).toFixed(2)}% (limit ${tolerance * 100}%)`,
        );
    }
  }
  return { status: reasons.length ? 'reference' : 'verified', reasons, changes };
}
