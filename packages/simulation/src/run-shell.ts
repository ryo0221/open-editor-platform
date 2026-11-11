import type { CadDocument, CadTopologyTable } from '@editor-platform/cad-core';
import type {
  CadAnalysisSurface,
  CadAnalysisSurfaceRequest,
} from '@editor-platform/cad-kernel-occt';
import {
  ElasticError,
  shellEquilibriumCheck,
  repairShellMesh,
  shellMeshFromSurface,
  shellRepairNote,
  shellSliverPlaces,
  shellMeshQuality,
  shellExpansionSize,
  shellQualityMin,
  solveShell,
  solveShellModal,
  type AddedMass,
  type ShellConstraint,
  type ShellInput,
  type ShellLoad,
  type ShellMesh,
  type ShellModalInput,
  type ShellModalResult,
  type ShellResult,
} from '@editor-platform/geometry-fem';
import {
  buildMapping,
  checkLoadApplication,
  loadApplicationTolerance,
  mappingReady,
  type MappingContext,
  type MappingRow,
  type RunCheck,
  type SimulationConstraint,
  type SimulationLoad,
  type SimulationDocument,
  type SimulationMaterial,
  type SimulationMeshSettings,
  type SimulationMetric,
} from '@editor-platform/simulation-core';
import {
  addedMasses,
  addedMassTotal,
  ConditionRefusal,
  modalChecks,
  shellConditions,
  shellLoadInput,
} from './run-conditions';

/**
 * R3i-4 (docs/cad/r3-analysis.md, A3): one level of a structural study with the `shell`
 * idealisation. The kernel gives the body's midsurface (`idealisation: 'shell'`), triangulated at
 * the level's size; it becomes a shell mesh with the wall's thickness, the targets map through the
 * midsurface history (a side of the wall onto midsurface edges), and the shell solver solves it.
 * The checks are a solid run's: mapping, load, quality (`shellQualityMin`), solver and equilibrium
 * (forces and moments) for a static study; mapping, mass (ρ t × the midsurface's area), quality,
 * solver and orthogonality for a modal one.
 */
export interface ShellStaticRunFields {
  kind: 'shell-static';
  mesh: ShellMesh;
  /** x, y, z, rx, ry, rz per node (mm, rad). */
  displacement: Float64Array;
  stress: ShellResult['stress'];
  vonMises: ShellResult['vonMises'];
  reaction: Float64Array;
}
export interface ShellModalRunFields {
  kind: 'shell-modal';
  mesh: ShellMesh;
  /** Shapes with 6 DOFs per node. */
  modes: { frequency: number; shape: Float64Array; effectiveMass: [number, number, number] }[];
}

/** Why a shell level stopped, in the run's own codes. */
export type ShellLevelFailure = {
  code:
    | 'surface'
    | 'table-mismatch'
    | 'mesh'
    | 'mesh-too-large'
    | 'mesh-quality'
    | 'mapping'
    | 'shell-target'
    | 'solve';
  detail: string;
};

export interface ShellLevelInput {
  doc: SimulationDocument;
  cad: CadDocument;
  table: CadTopologyTable;
  kind: 'linear-static' | 'modal';
  modes: number;
  solver: { tolerance: number; maxIterations: number };
  material: SimulationMaterial;
  loads: SimulationLoad[];
  constraints: SimulationConstraint[];
  settings: SimulationMeshSettings;
  /** The surface request of the level, without the idealisation. */
  request: Omit<CadAnalysisSurfaceRequest, 'idealisation' | 'minEdgeMm'>;
  limits: { nodes: number; elements: number };
  /**
   * R3j-5a: a static study solved on a compute Host instead (`solveShellOnHost`): its `limits`
   * are for the wedges the shell is sent as (`shellExpansionSize`), and `equilibrium` the
   * imbalance its 6-digit results allow.
   */
  remote?: {
    name: string;
    solve?(input: ShellInput): Promise<ShellResult>;
    /** R3j-5c: a modal study on the Host (`solveShellModalOnHost`), checked by `modalChecks`. */
    solveModal?(input: ShellModalInput): Promise<ShellModalResult>;
    equilibrium?: number;
    orthogonality?: number;
  };
  context: MappingContext;
  surface(
    cad: CadDocument,
    request: CadAnalysisSurfaceRequest,
  ): Promise<{ surface: CadAnalysisSurface } | { code: string; detail?: string }>;
  sameTable(a: CadTopologyTable, b: CadTopologyTable): boolean;
  step(s: 'surface' | 'mesh' | 'mapping' | 'solve' | 'checks'): Promise<void> | void;
}
export type ShellLevelResult =
  | {
      nodes: number;
      elements: number;
      metrics: Partial<Record<SimulationMetric, number>>;
      checks: RunCheck[];
      mapping: MappingRow[];
      fields: ShellStaticRunFields | ShellModalRunFields;
    }
  | { failure: ShellLevelFailure; mapping: MappingRow[] };

export async function runShellLevel(input: ShellLevelInput): Promise<ShellLevelResult> {
  let mapping: MappingRow[] = [];
  const fail = (code: ShellLevelFailure['code'], detail: string): ShellLevelResult => ({
    failure: { code, detail },
    mapping,
  });
  const { material, loads, constraints } = input;

  await input.step('surface');
  // No graded refinement: that keeps the volume mesher off slivers; a shell has no volume.
  const result = await input.surface(input.cad, { ...input.request, idealisation: 'shell' });
  if (!('surface' in result))
    return fail('surface', result.detail ? `${result.code}: ${result.detail}` : result.code);
  const surface = result.surface;
  if (!surface.shell) return fail('surface', 'the kernel gave no midsurface');
  if (!input.sameTable(surface.bodyTopology, input.table))
    return fail('table-mismatch', 'the kernel evaluated another body table');
  // A side face of the wall becomes midsurface edges, which the kernel does not size: refuse its
  // finer size rather than leave it out (a wall face's size reaches its midsurface face).
  const sides = (input.request.faceSizes ?? [])
    .map((s) => s.face)
    .filter((f) => surface.history.faces[f]?.deleted);
  if (sides.length)
    return fail(
      'shell-target',
      `a finer size on a side face of the wall (body face ${sides.join(', ')}) is not applied to a shell; give it to a wall face instead`,
    );

  await input.step('mesh');
  let mesh: ShellMesh;
  let mended = '';
  try {
    // CR1a: the kernel's triangulation leaves slivers where shallow chains meet; mend them first.
    const repair = repairShellMesh(shellMeshFromSurface(surface, surface.shell.thicknessMm));
    mesh = repair.mesh;
    mended = shellRepairNote(repair);
  } catch (e) {
    return fail('mesh', e instanceof Error ? e.message : String(e));
  }
  const nodes = mesh.nodes.length / 3;
  const elements = mesh.triangles.length / 3;
  // What goes to the Host, if this study goes: the shell as its wedges.
  const host = input.kind === 'modal' ? input.remote?.solveModal : input.remote?.solve;
  if (input.remote && host) {
    const sent = shellExpansionSize(mesh);
    if (sent.nodes > input.limits.nodes || sent.elements > input.limits.elements)
      return fail(
        'mesh-too-large',
        `${nodes} nodes, ${elements} triangles: ${sent.nodes} nodes, ${sent.elements} wedges on ${input.remote.name}`,
      );
  } else if (nodes > input.limits.nodes || elements > input.limits.elements)
    return fail('mesh-too-large', `${nodes} nodes, ${elements} triangles`);
  const quality = shellMeshQuality(mesh);
  const qualityDetail =
    `min angle ${quality.minAngleDeg}°, max aspect ratio ${quality.maxAspect}, ` +
    `thickness ${surface.shell.thicknessMm} mm${mended}`;
  if (quality.below.length)
    return fail(
      'mesh-quality',
      `${quality.below.length} triangles below ${shellQualityMin.minAngleDeg}° or above aspect ` +
        `${shellQualityMin.maxAspect} at ${shellSliverPlaces(mesh, quality.below)}; ${qualityDetail}`,
    );

  await input.step('mapping');
  const facesMeshed = new Set(mesh.faces);
  mapping = buildMapping(
    input.doc,
    input.table,
    { ...surface.history, midsurface: true },
    {
      faces: (tag) => facesMeshed.has(tag),
      edges: (e) => e < mesh.shapeEdges && mesh.edges.offsets[e + 1]! > mesh.edges.offsets[e]!,
    },
    input.context,
  );
  if (!mappingReady(mapping)) {
    const open = mapping.filter((r) => r.status !== 'resolved');
    return fail(
      'mapping',
      open.map((r) => `${r.path}: ${r.status} (${r.reason ?? r.stage})`).join('; '),
    );
  }
  /** The midsurface faces or edges an item applies to; `reversed` picks the far side's faces. */
  const of = (owner: string, kind: 'face' | 'edge', reversed?: boolean) =>
    [
      ...new Set(
        mapping
          .filter(
            (r) =>
              r.owner === owner &&
              (r.as ?? r.kind) === kind &&
              (reversed === undefined || !!r.reversed === reversed),
          )
          .flatMap((r) => r.analysis),
      ),
    ].sort((a, b) => a - b);
  const { faceAreas } = surface.measures;

  let shellLoads: ShellLoad[];
  let shellConstraints: ShellConstraint[];
  let masses: AddedMass[];
  try {
    ({ loads: shellLoads, constraints: shellConstraints } = shellConditions(
      loads,
      constraints,
      of,
    ));
    masses = addedMasses(input.doc.masses ?? [], of);
  } catch (e) {
    if (e instanceof ConditionRefusal) return fail('shell-target', e.message);
    throw e;
  }
  const t = surface.shell.thicknessMm;
  const qualityCheck: RunCheck = { name: 'quality', pass: true, detail: qualityDetail };
  const mappingCheck: RunCheck = {
    name: 'mapping',
    pass: true,
    detail: `${mapping.length} targets resolved`,
  };
  const solveFailure = (e: unknown) => {
    if (e instanceof ElasticError)
      return fail(
        'solve',
        `${e.problem}: ${e.detail}${e.modes.length ? ` (${e.modes.join(', ')})` : ''}`,
      );
    throw e;
  };

  if (input.kind === 'modal') {
    await input.step('solve');
    let modal: ShellModalResult;
    const modalInput: ShellModalInput = {
      mesh,
      material,
      constraints: shellConstraints,
      masses,
      modes: input.modes,
      solver: input.solver,
    };
    const onHost = input.remote?.solveModal;
    try {
      modal = onHost ? await onHost(modalInput) : solveShellModal(modalInput);
    } catch (e) {
      return solveFailure(e);
    }
    await input.step('checks');
    const area = faceAreas.reduce((s, a) => s + a, 0);
    const added = addedMassTotal(input.doc.masses ?? []);
    const shapeMass = material.density * t * area + added;
    const massChange = Math.abs(modal.mass - shapeMass) / Math.max(shapeMass, 1e-300);
    const empty = constraints.filter((_, i) => !modal.constrainedNodes[i]);
    return {
      nodes,
      elements,
      mapping,
      metrics: { 'first-frequency': modal.modes[0]!.frequency },
      checks: [
        mappingCheck,
        {
          name: 'mass',
          pass: massChange <= loadApplicationTolerance.area && !empty.length,
          detail:
            `mesh ${modal.mass} t for ${shapeMass} t (ρ t × midsurface area` +
            (added ? ` + ${added} t added)` : ')') +
            (empty.length ? `; ${empty.map((c) => c.id).join(', ')} hold no node` : ''),
        },
        qualityCheck,
        ...modalChecks(
          modal,
          onHost ? input.remote : undefined,
          onHost ? ' (the shell as 15-node wedges)' : '',
        ),
      ],
      fields: {
        kind: 'shell-modal',
        mesh,
        modes: modal.modes.map((m) => ({
          frequency: m.frequency,
          shape: m.shape,
          effectiveMass: m.effectiveMass,
        })),
      },
    };
  }

  await input.step('solve');
  let r: ShellResult;
  const shellInput: ShellInput = {
    mesh,
    material,
    loads: shellLoads,
    constraints: shellConstraints,
    masses,
    solver: input.solver,
  };
  const onHost = input.remote?.solve;
  try {
    r = onHost ? await onHost(shellInput) : solveShell(shellInput);
  } catch (e) {
    return solveFailure(e);
  }

  await input.step('checks');
  const loadInput = shellLoadInput(loads, r.loadChecks, of, surface.measures);
  const held = constraints.map((c, i) => ({ owner: c.id, nodes: r.constrainedNodes[i]! }));
  const loadChecks = checkLoadApplication({ loads: loadInput, constraints: held });
  const eq = shellEquilibriumCheck(r, onHost ? input.remote?.equilibrium : undefined);
  let maxU = 0,
    maxVm = 0;
  for (let p = 0; p < nodes; p++) {
    maxVm = Math.max(maxVm, r.vonMises.max[p]!);
    maxU = Math.max(
      maxU,
      Math.hypot(r.displacement[6 * p]!, r.displacement[6 * p + 1]!, r.displacement[6 * p + 2]!),
    );
  }
  const bad = loadChecks.filter((c) => !c.ok);
  return {
    nodes,
    elements,
    mapping,
    metrics: {
      'max-displacement': maxU,
      'max-von-mises': maxVm,
      'reaction-force': Math.hypot(...r.reactionTotal),
    },
    checks: [
      mappingCheck,
      {
        name: 'load',
        pass: bad.length === 0,
        detail: bad.length
          ? bad.map((c) => `${c.owner} ${c.quantity}: ${c.actual} for ${c.expected}`).join('; ')
          : `${loadChecks.length} checks`,
      },
      qualityCheck,
      {
        name: 'solver',
        pass: r.converged,
        detail: onHost
          ? `direct solve of the shell as 15-node wedges on ${input.remote!.name}`
          : `${r.iterations} iterations, residual ${r.residual}`,
      },
      {
        name: 'equilibrium',
        pass: eq.pass,
        detail: `force ${eq.force} of ${eq.forceScale}, moment ${eq.moment} of ${eq.momentScale}`,
      },
    ],
    fields: {
      kind: 'shell-static',
      mesh,
      displacement: r.displacement,
      stress: r.stress,
      vonMises: r.vonMises,
      reaction: r.reaction,
    },
  };
}
