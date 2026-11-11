import { calculixEigenvalueAgreement } from '@editor-platform/geometry-fem';
import type {
  AddedMass,
  ElasticConstraint,
  ElasticLoad,
  ShellConstraint,
  ShellLoad,
} from '@editor-platform/geometry-fem';
import type {
  checkLoadApplication,
  RunCheck,
  SimulationConstraint,
  SimulationLoad,
  SimulationMass,
} from '@editor-platform/simulation-core';

/**
 * A study's loads and constraints on one body's mesh, as the solvers take them, and what they put
 * on the mesh as the load check reads it. Shared by the one-body runs (`run.ts`, `run-shell.ts`)
 * and the bonded run (R3j-4b, `run-bonded.ts`).
 */

/** The analysis faces or edges an item applies to; `reversed` picks a wall's far faces (shell). */
export type TargetsOf = (owner: string, kind: 'face' | 'edge', reversed?: boolean) => number[];
export interface SurfaceMeasures {
  faceAreas: ArrayLike<number>;
  faceVectorAreas: ArrayLike<number>;
  edgeLengths: ArrayLike<number>;
}
type LoadInput = Parameters<typeof checkLoadApplication>[0]['loads'];

/** A load or constraint the body's idealisation cannot apply, with the run's code. */
export class ConditionRefusal extends Error {
  constructor(
    readonly code: 'load-targets-mixed' | 'roller-direction' | 'shell-target',
    message: string,
  ) {
    super(message);
  }
}

const sum = (list: number[], f: (i: number) => number) => list.reduce((s, i) => s + f(i), 0);

/**
 * CR5a: the document's added masses on one body's mesh: each on the analysis faces its targets
 * mapped to (a shell wall's either side), the solvers spreading it by area.
 */
export function addedMasses(masses: readonly SimulationMass[], of: TargetsOf): AddedMass[] {
  return masses.map((m) => {
    // A shell wall's side face maps to a midsurface edge: a mass there has no area to spread
    // over, so it is refused rather than moved onto the other faces (Codex on #975).
    if (of(m.id, 'edge').length)
      throw new ConditionRefusal(
        'shell-target',
        `${m.id}: an added mass on a wall's side face (an edge of the midsurface)`,
      );
    return { faces: of(m.id, 'face'), mass: m.mass };
  });
}
/** CR5a: the total of the added masses (t), for the mass check. */
export const addedMassTotal = (masses: readonly SimulationMass[]) =>
  masses.reduce((s, m) => s + m.mass, 0);

/** A solid's loads and constraints. A roller becomes one constraint per face, in order. */
export function solidConditions(
  loads: readonly SimulationLoad[],
  constraints: readonly SimulationConstraint[],
  of: TargetsOf,
  measures: SurfaceMeasures,
): { loads: ElasticLoad[]; constraints: ElasticConstraint[] } {
  const { faceAreas, faceVectorAreas } = measures;
  return {
    loads: loads.map((l): ElasticLoad => {
      if (l.kind === 'gravity') return { kind: 'gravity', acceleration: l.acceleration };
      const faces = of(l.id, 'face');
      const edges = of(l.id, 'edge');
      if (l.kind === 'pressure') return { kind: 'pressure', faces, pressure: l.pressure };
      if (l.kind !== 'force') throw new Error('a structural study takes no thermal load');
      if (faces.length && edges.length)
        throw new ConditionRefusal(
          'load-targets-mixed',
          `${l.id}: a force on faces and edges at once`,
        );
      return faces.length
        ? { kind: 'face-force', faces, force: l.force }
        : { kind: 'edge-force', edges, force: l.force };
    }),
    constraints: constraints.flatMap((c): ElasticConstraint[] => {
      const faces = of(c.id, 'face');
      const edges = of(c.id, 'edge');
      // A solid has no rotations: pinned holds as fixed does (R3i-4).
      if (c.kind === 'fixed' || c.kind === 'pinned')
        return [{ faces, edges, displacement: [0, 0, 0] }];
      if (c.kind === 'displacement') return [{ faces, edges, displacement: c.displacement }];
      if (c.kind === 'temperature') throw new Error('a structural study holds no temperature');
      // A roller holds the normal of each planar face; only an axis-aligned normal is applied.
      if (edges.length)
        throw new ConditionRefusal('roller-direction', `${c.id}: a roller on an edge`);
      return faces.map((f) => {
        const v = [0, 1, 2].map((d) => faceVectorAreas[3 * f + d]!);
        const area = faceAreas[f]!;
        const axis = v.findIndex((x) => Math.abs(x) >= area * (1 - 1e-9));
        if (!(area > 0) || axis < 0)
          throw new ConditionRefusal(
            'roller-direction',
            `${c.id}: face ${f} is not a plane normal to x, y or z`,
          );
        const displacement: ElasticConstraint['displacement'] = [null, null, null];
        displacement[axis] = 0;
        return { faces: [f], edges: [], displacement };
      });
    }),
  };
}

/** What a solid's loads put on the mesh (its `loadChecks`, one per load) against the request. */
export function solidLoadInput(
  loads: readonly SimulationLoad[],
  checks: readonly { force: [number, number, number]; measure: number }[],
  of: TargetsOf,
  measures: SurfaceMeasures,
): LoadInput {
  const { faceAreas, faceVectorAreas, edgeLengths } = measures;
  return loads.flatMap((l, i): LoadInput => {
    if (l.kind === 'gravity' || l.kind === 'heat-flux' || l.kind === 'convection') return [];
    const applied = checks[i]!;
    const faces = of(l.id, 'face');
    const edges = of(l.id, 'edge');
    const area = sum(faces, (f) => faceAreas[f]!);
    if (l.kind === 'pressure') {
      // Positive pressure pushes along the inward normal: −p ∫ n dA over the faces.
      const requested = [0, 1, 2].map(
        (d) => -l.pressure * sum(faces, (f) => faceVectorAreas[3 * f + d]!),
      ) as [number, number, number];
      return [
        {
          owner: l.id,
          kind: 'pressure' as const,
          requested,
          applied: applied.force,
          gross: Math.abs(l.pressure) * area,
          meshMeasure: applied.measure,
          shapeMeasure: area,
          measure: 'area' as const,
        },
      ];
    }
    return [
      {
        owner: l.id,
        kind: 'force' as const,
        requested: l.force,
        applied: applied.force,
        gross: Math.hypot(...l.force),
        meshMeasure: applied.measure,
        shapeMeasure: faces.length ? area : sum(edges, (e) => edgeLengths[e]!),
        measure: faces.length ? ('area' as const) : ('length' as const),
      },
    ];
  });
}

/** The nodes each constraint holds on a solid (a roller's faces together). */
export function solidHeld(
  constraints: readonly SimulationConstraint[],
  constrainedNodes: readonly number[],
  of: TargetsOf,
): { owner: string; nodes: number }[] {
  let k = 0;
  return constraints.map((c) => {
    const n = c.kind === 'roller' ? of(c.id, 'face').length : 1;
    const total = constrainedNodes.slice(k, k + n).reduce((t, x) => t + x, 0);
    k += n;
    return { owner: c.id, nodes: total };
  });
}

/** A shell's loads (a pressure on both sides of the wall as two) and constraints. */
export function shellConditions(
  loads: readonly SimulationLoad[],
  constraints: readonly SimulationConstraint[],
  of: TargetsOf,
): { loads: ShellLoad[]; constraints: ShellConstraint[] } {
  return {
    loads: loads.flatMap((l): ShellLoad[] => {
      if (l.kind === 'gravity') return [{ kind: 'gravity', acceleration: l.acceleration }];
      if (l.kind !== 'force' && l.kind !== 'pressure')
        throw new Error('a structural study takes no thermal load');
      const faces = of(l.id, 'face');
      const edges = of(l.id, 'edge');
      if (l.kind === 'pressure') {
        // A pressure pushes against its face's outward normal: against the midsurface's on the
        // near face, along it on the far one. On a side (an edge of the midsurface) it has no area.
        if (edges.length)
          throw new ConditionRefusal('shell-target', `${l.id}: a pressure on a side of the wall`);
        const near = of(l.id, 'face', false),
          far = of(l.id, 'face', true);
        return [
          ...(near.length
            ? [{ kind: 'pressure' as const, faces: near, pressure: l.pressure }]
            : []),
          ...(far.length ? [{ kind: 'pressure' as const, faces: far, pressure: -l.pressure }] : []),
        ];
      }
      if (faces.length && edges.length)
        throw new ConditionRefusal(
          'shell-target',
          `${l.id}: a force on midsurface faces and edges at once`,
        );
      return [
        faces.length
          ? { kind: 'face-force', faces, force: l.force }
          : { kind: 'edge-force', edges, force: l.force },
      ];
    }),
    constraints: constraints.map((c): ShellConstraint => {
      const faces = of(c.id, 'face');
      const edges = of(c.id, 'edge');
      if (c.kind === 'fixed') return { faces, edges, displacement: [0, 0, 0], rotation: [0, 0, 0] };
      if (c.kind === 'pinned')
        return { faces, edges, displacement: [0, 0, 0], rotation: [null, null, null] };
      if (c.kind === 'displacement')
        return { faces, edges, displacement: c.displacement, rotation: [null, null, null] };
      if (c.kind === 'roller')
        throw new ConditionRefusal('shell-target', `${c.id}: a roller is not applied to a shell`);
      throw new Error('a structural study holds no temperature');
    }),
  };
}

/** What a shell's loads put on the mesh (its `loadChecks`, a pressure on both sides as two). */
export function shellLoadInput(
  loads: readonly SimulationLoad[],
  checks: readonly { force: [number, number, number]; measure: number }[],
  of: TargetsOf,
  measures: SurfaceMeasures,
): LoadInput {
  const { faceAreas, faceVectorAreas, edgeLengths } = measures;
  let k = 0;
  return loads.flatMap((l): LoadInput => {
    if (l.kind === 'gravity') {
      k++;
      return [];
    }
    if (l.kind !== 'force' && l.kind !== 'pressure') return [];
    if (l.kind === 'pressure') {
      const near = of(l.id, 'face', false),
        far = of(l.id, 'face', true);
      const parts = (near.length ? 1 : 0) + (far.length ? 1 : 0);
      const applied = [0, 1, 2].map((d) =>
        checks.slice(k, k + parts).reduce((s, c) => s + c.force[d]!, 0),
      ) as [number, number, number];
      const measure = checks.slice(k, k + parts).reduce((s, c) => s + c.measure, 0);
      k += parts;
      // Against the near faces' normal, along the far ones': −p (∫n dA near − ∫n dA far).
      const requested = [0, 1, 2].map(
        (d) =>
          -l.pressure *
          (sum(near, (f) => faceVectorAreas[3 * f + d]!) -
            sum(far, (f) => faceVectorAreas[3 * f + d]!)),
      ) as [number, number, number];
      const area = sum([...near, ...far], (f) => faceAreas[f]!);
      return [
        {
          owner: l.id,
          kind: 'pressure',
          requested,
          applied,
          gross: Math.abs(l.pressure) * area,
          meshMeasure: measure,
          shapeMeasure: area,
          measure: 'area',
        },
      ];
    }
    const c = checks[k++]!;
    const faces = of(l.id, 'face');
    const edges = of(l.id, 'edge');
    return [
      {
        owner: l.id,
        kind: 'force',
        requested: l.force,
        applied: c.force,
        gross: Math.hypot(...l.force),
        meshMeasure: c.measure,
        shapeMeasure: faces.length
          ? sum(faces, (f) => faceAreas[f]!)
          : sum(edges, (e) => edgeLengths[e]!),
        measure: faces.length ? 'area' : 'length',
      },
    ];
  });
}

/** R3j-5c: where a modal study was solved off the browser, and what its checks allow. */
export interface ModalHost {
  name: string;
  /** The largest Rayleigh and orthogonality deviation the Host's results may have (default 1e-6). */
  orthogonality?: number;
}

/**
 * The solver and orthogonality checks of a modal run. In the browser: LOBPCG's convergence and
 * residual, and M-orthogonality. On a Host (R3j-5c, `calculixModalSummary`): CalculiX's modes
 * checked from their internal forces K φ: each frequency is its Rayleigh quotient φᵀ K φ and
 * CalculiX's printed eigenvalue agrees with it within `calculixEigenvalueAgreement` (CR0a), and
 * the K-orthogonality |φᵢᵀ K φⱼ| / √(λᵢ λⱼ) of distinct modes stays within the Host's tolerance.
 */
export function modalChecks(
  r: {
    converged: boolean;
    iterations: number;
    orthogonality: number;
    modes: readonly { residual: number }[];
  },
  host: ModalHost | undefined,
  extra = '',
): RunCheck[] {
  const worst = Math.max(0, ...r.modes.map((m) => m.residual));
  if (!host)
    return [
      {
        name: 'solver',
        pass: r.converged,
        detail: `${r.iterations} LOBPCG steps, largest residual ${worst}${extra}`,
      },
      {
        name: 'orthogonality',
        pass: r.orthogonality <= 1e-6,
        detail: `largest |φᵢᵀ M φⱼ − δᵢⱼ| ${r.orthogonality}`,
      },
    ];
  const tolerance = host.orthogonality ?? 1e-6;
  return [
    {
      name: 'solver',
      pass: r.converged && worst <= calculixEigenvalueAgreement,
      detail:
        `eigensolve on ${host.name}, frequencies from φᵀ K φ; largest |φᵀ K φ / λ_CalculiX − 1| ` +
        `${worst} (allowed ${calculixEigenvalueAgreement})${extra}`,
    },
    {
      name: 'orthogonality',
      pass: r.orthogonality <= tolerance,
      detail: `largest |φᵢᵀ K φⱼ| / √(λᵢ λⱼ) ${r.orthogonality} (from the Host's K φ)`,
    },
  ];
}
