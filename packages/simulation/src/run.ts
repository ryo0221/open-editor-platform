import type {
  CadDocument,
  CadSpotWeldPoints,
  CadTopologyRef,
  CadTopologyTable,
} from '@editor-platform/cad-core';
import { stiffnessTestResult } from './stiffness-test';
import { resolveTopologyRef } from '@editor-platform/cad-core';
import type {
  CadAnalysisSurface,
  CadAnalysisSurfaceRequest,
  CadAnalysisSurfaceResult,
} from '@editor-platform/cad-kernel-occt';
import type { MeshReport, MesherSettings } from '@editor-platform/fem-mesher';
import {
  ElasticError,
  curvedJacobianMin,
  meshShapeQuality,
  shapeQualityMin,
  equilibriumCheck,
  solveElastic,
  solveModal,
  solveThermal,
  type ThermalCondition,
  type ThermalResult,
  type AddedMass,
  type ElasticConstraint,
  type ModalInput,
  type ModalResult,
  type ShellModalInput,
  type ShellModalResult,
  type BondedModalInput,
  type BondedModalResult,
  type ElasticInput,
  type ElasticLoad,
  type ElasticResult,
  type FemMesh,
  type BondedInput,
  type BondedResult,
  type ShellInput,
  type ShellResult,
} from '@editor-platform/geometry-fem';
import {
  runBondedLevel,
  type BondedModalRunFields,
  type BondedStaticRunFields,
} from './run-bonded';
import { runShellLevel, type ShellModalRunFields, type ShellStaticRunFields } from './run-shell';
import {
  addedMasses,
  addedMassTotal,
  ConditionRefusal,
  modalChecks,
  solidConditions,
  solidHeld,
  solidLoadInput,
  type ModalHost,
} from './run-conditions';
import {
  buildMapping,
  checkLoadApplication,
  checkSimulationSource,
  loadApplicationTolerance,
  convergenceLevelSettings,
  mappingReady,
  simulationLimits,
  simulationPreparationHash,
  studyStatus,
  validateSimulation,
  type MappingRow,
  type RunCheck,
  type SimulationDocument,
  type SimulationMeshSettings,
  type SimulationMetric,
  type SimulationTarget,
  type StudyStatus,
} from '@editor-platform/simulation-core';

/**
 * R3e-3: one linear static study run end to end (docs/cad/r3-analysis.md, 解法と検査): for each
 * convergence level the kernel's analysis surface (with the preparation), the mesh, the mapping
 * of every target, the loads and constraints on the mesh, the solve, the five checks, and at the
 * end the study's state. The kernel and the mesher are given (`RunEnvironment`), so the same run
 * goes in a Worker, in Node tests or on a Host; this module holds no module of its own.
 */
export interface RunEnvironment {
  /** The analysis surface of the source body (the kernel's `evaluateCad` `analysisSurface`). */
  surface(cad: CadDocument, request: CadAnalysisSurfaceRequest): Promise<CadAnalysisSurfaceResult>;
  /** Netgen on that surface (`meshSurfaceReport`); throws `MesherError`. */
  mesh(surface: CadAnalysisSurface, settings: MesherSettings): MeshReport;
  /** The builds the run names, for the stored re-selections and the record. */
  builds: { kernel: string; mesher: string; solver: string };
  /** Between steps; throw to cancel. */
  checkpoint?(progress: RunProgress): Promise<void> | void;
  /**
   * CR5b: the points of the CAD version's spot weld rows (the kernel's `spotWelds` of a display
   * evaluation), for a document that takes some into the analysis, with the bodies' display
   * tables of that evaluation (the welded flanges are found on them when no table is given).
   */
  spotWelds?(cad: CadDocument): Promise<{
    rows: readonly CadSpotWeldPoints[];
    tables: ReadonlyMap<string, CadTopologyTable>;
  }>;
  /**
   * R3f-3: solve somewhere else (a compute Host) instead of the browser solver, within its own
   * mesh limits. `solve` gets the same input and gives the same result or throws `ElasticError`;
   * `name` says where, in the progress and the solver check.
   */
  remote?: {
    name: string;
    limits: { nodes: number; elements: number };
    solve(input: ElasticInput): Promise<ElasticResult>;
    /**
     * R3j-5a: a static shell study on the Host (`solveShellOnHost`); without it a shell study is
     * refused with `host`.
     */
    solveShell?(input: ShellInput): Promise<ShellResult>;
    /** R3j-5b: a static study of bonded bodies on the Host (`solveBondedOnHost`). */
    solveBonded?(input: BondedInput): Promise<BondedResult>;
    /**
     * R3j-5c: modal studies on the Host (`solveModalOnHost`, `solveShellModalOnHost`,
     * `solveBondedModalOnHost`); without the one a modal study needs it is refused with `host`.
     */
    solveModal?(input: ModalInput): Promise<ModalResult>;
    solveShellModal?(input: ShellModalInput): Promise<ShellModalResult>;
    solveBondedModal?(input: BondedModalInput): Promise<BondedModalResult>;
    /** The relative imbalance the equilibrium check allows for its results (default 1e-6). */
    equilibrium?: number;
    /** R3j-5c: what the modal checks allow for its modes (`modalChecks`, default 1e-6). */
    orthogonality?: number;
  };
}
export interface RunProgress {
  level: number;
  levels: number;
  step: 'surface' | 'mesh' | 'mapping' | 'solve' | 'checks';
  /** Where the solve runs, when not in the browser. */
  on?: string;
}

/** Why a run left no result. */
export type RunFailureCode =
  | 'simulation-invalid'
  | 'study-missing'
  | 'source'
  | 'material-missing'
  | 'table-mismatch'
  | 'target-unresolved'
  | 'surface'
  | 'mesh'
  | 'mesh-too-large'
  | 'mesh-quality'
  | 'mapping'
  | 'load-targets-mixed'
  | 'roller-direction'
  /** R3i-4: a load or constraint a shell study cannot apply (a pressure on a side, a roller). */
  | 'shell-target'
  /** R3j-2: other bodies are analysed with the source body; their bonds are solved from R3j-4. */
  | 'multi-body'
  | 'solve'
  /** R3f-3: the compute Host could not be reached, refused the job, failed or sent a bad result. */
  | 'host'
  /** CR5b: a spot weld row taken into the analysis has no points on this version. */
  | 'spot-weld';
export interface RunFailure {
  code: RunFailureCode;
  detail: string;
  /** The level it stopped at (0 = the document's mesh settings), when it got that far. */
  level?: number;
}

export interface RunLevel {
  settings: SimulationMeshSettings;
  nodes: number;
  elements: number;
  metrics: Partial<Record<SimulationMetric, number>>;
  checks: RunCheck[];
}
/** The finest level's fields, for display and VTU (nodal, mm and MPa). */
export type RunFields =
  | StaticRunFields
  | ModalRunFields
  | ThermalRunFields
  | ShellStaticRunFields
  | ShellModalRunFields
  | BondedStaticRunFields
  | BondedModalRunFields;
/** R3h: a thermal run's nodal temperature (K) and heat flux −k∇T (mW/mm², x y z, and |q|). */
export interface ThermalRunFields {
  kind: 'thermal';
  mesh: FemMesh;
  temperature: Float64Array;
  flux: Float64Array;
  fluxMagnitude: Float64Array;
}
/** R3h: the heat balance a thermal run passes with, relative to the largest condition's heat. */
export const thermalBalanceTolerance = 1e-6;
/**
 * R3h: whether a thermal run's heat balance (mW) passes. It is measured against the largest heat
 * any condition moves, but never against less than a thousandth of k · L · |T|max (L the mesh's
 * bounding-box diagonal): the size of the reactions' own roundoff. A study that moves no heat (one
 * held temperature or one convection alone, so the body ends at that temperature) is left with
 * only that roundoff, which then passes; a real imbalance of any sizeable heat still fails.
 */
/**
 * R3h: the `max-heat-flux` metric of a thermal level (mW/mm²). A flux below 1e-9 · k · |T|max / L
 * (the gradient of a billionth of the temperature across the body) is roundoff of a body that
 * moves no heat and counts as 0, so two such levels agree instead of comparing noise.
 */
export function thermalFluxMetric(
  maxFlux: number,
  roundoff: { conductivity: number; diagonal: number; maxAbsTemperature: number },
): number {
  const floor =
    (1e-9 * roundoff.conductivity * roundoff.maxAbsTemperature) /
    Math.max(roundoff.diagonal, 1e-300);
  return maxFlux <= floor ? 0 : maxFlux;
}
export function thermalBalancePasses(
  balance: number,
  heatScale: number,
  roundoff: { conductivity: number; diagonal: number; maxAbsTemperature: number },
): boolean {
  const floor = 1e-3 * roundoff.conductivity * roundoff.diagonal * roundoff.maxAbsTemperature;
  return Math.abs(balance) <= thermalBalanceTolerance * Math.max(heatScale, floor);
}
export interface StaticRunFields {
  kind?: 'linear-static';
  mesh: FemMesh;
  displacement: Float64Array;
  stress: Float64Array;
  vonMises: Float64Array;
  reaction: Float64Array;
}
/** R3g: the modes of a modal run, lowest first. */
export interface ModalRunFields {
  kind: 'modal';
  mesh: FemMesh;
  modes: { frequency: number; shape: Float64Array; effectiveMass: [number, number, number] }[];
}
export interface StudyRun {
  studyId: string;
  status: StudyStatus;
  levels: RunLevel[];
  /** The finest solved level's mapping table (empty when the run stopped before one). */
  mapping: MappingRow[];
  fields?: RunFields;
  failure?: RunFailure;
  builds: RunEnvironment['builds'];
}

/** The kernel's chordal deflection for a level: well under the element size, within its range. */
export const runDeflectionMm = (size: number) => Math.min(10, Math.max(1e-3, size / 50));

/**
 * Runs study `studyId` of `doc` on `cad`, the source version (its content hash must be the
 * document's). `table` is the source body's topology table from the caller's own evaluation of
 * that version (the display one): explicit removals and local sizes resolve on it, and it must be
 * the table the kernel's surface reports. Every refusal is a `failed` run with its reason; no
 * input is repaired.
 */
export async function runStudy(
  doc: SimulationDocument,
  cad: CadDocument,
  cadContentHash: string,
  studyId: string,
  table: CadTopologyTable,
  env: RunEnvironment,
  /** R3j-4b: the other bodies' display tables; the kernel's is used for a body not given. */
  bodyTables?: ReadonlyMap<string, CadTopologyTable>,
): Promise<StudyRun> {
  const levels: RunLevel[] = [];
  let mapping: MappingRow[] = [];
  let fields: RunFields | undefined;
  const study = doc.studies.find((s) => s.id === studyId);
  /** CR5c: a stiffness test's result on the level just solved, as its `stiffness` metric. */
  const measureTest = () => {
    if (study?.kind !== 'linear-static' || !study.test || !fields) return;
    const r = stiffnessTestResult(doc, { studyId, mapping, fields });
    if (r && r.kind !== 'refused') levels[levels.length - 1]!.metrics.stiffness = r.stiffness;
  };
  const failed = (code: RunFailureCode, detail: string, level?: number): StudyRun => ({
    studyId,
    status: study
      ? studyStatus({ study, failure: `${code}: ${detail}`, checks: [], levels: [] })
      : { status: 'failed', reasons: [`${code}: ${detail}`], changes: {} },
    levels,
    mapping,
    failure: { code, detail, ...(level === undefined ? {} : { level }) },
    builds: env.builds,
  });
  const invalid = validateSimulation(doc);
  if (invalid.length) return failed('simulation-invalid', invalid.map((d) => d.code).join(', '));
  if (!study) return failed('study-missing', studyId);
  // R3j-4b: several bodies, or bonds, are solved together (linear static, in the browser).
  const bonded = !!(doc.bodies?.length || doc.bonds?.length || doc.spotWelds?.length);
  if (bonded && study.kind === 'thermal')
    return failed('multi-body', 'a thermal study is solved for one body');
  if (bonded && env.remote && study.kind === 'linear-static' && !env.remote.solveBonded)
    return failed('host', `${env.remote.name} does not solve bonded bodies`);
  // R3j-4b: removals and local sizes are the source body's only; one on another body is refused
  // rather than resolved on the source body's table.
  const elsewhere = [
    ...doc.preparation.removeFaces.map((t, i) => ({ t, path: `$.preparation.removeFaces[${i}]` })),
    ...doc.mesh.local.map((l, i) => ({ t: l.target, path: `$.mesh.local[${i}]` })),
  ].filter(({ t }) => t.body !== undefined && t.body !== doc.source.bodyId);
  if (elsewhere.length)
    return failed(
      'target-unresolved',
      `${elsewhere.map((x) => `${x.path} (body ${x.t.body})`).join(', ')}: removals and local sizes apply to the source body only`,
    );
  const source = checkSimulationSource(doc, cad);
  if (cadContentHash !== doc.source.contentHash)
    return failed('source', 'the CAD version is not the document source');
  if (source.length) return failed('source', source.map((d) => d.code).join(', '));
  const material = doc.materials.find((m) => m.id === doc.materialId);
  if (!material) return failed('material-missing', 'no material on the body');
  const others = (doc.bodies ?? []).map((b) => ({
    ...b,
    material: doc.materials.find((m) => m.id === b.materialId),
  }));
  const unmade = others.filter((b) => !b.material);
  if (unmade.length)
    return failed('material-missing', `no material on ${unmade.map((b) => b.bodyId).join(', ')}`);

  // Explicit removals and local face sizes resolve on the body's table (F1), never by nearness.
  const resolveFace = (ref: Parameters<typeof resolveTopologyRef>[1], path: string) => {
    const r = resolveTopologyRef(table, ref);
    if (r.status !== 'resolved') throw new RunRefusal('target-unresolved', `${path}: ${r.status}`);
    return r.index;
  };
  let removeFaces: number[];
  /** The face each of `doc.mesh.local` sizes, in its order. */
  let localFaces: number[];
  try {
    removeFaces = doc.preparation.removeFaces.map((t, i) => {
      if (t.kind !== 'face')
        throw new RunRefusal('target-unresolved', `$.preparation.removeFaces[${i}]: not a face`);
      return resolveFace(t.ref, `$.preparation.removeFaces[${i}]`);
    });
    localFaces = doc.mesh.local.map((l, i) => {
      // The kernel sizes faces only; an edge's local size is not applied (out of scope).
      if (l.target.kind !== 'face')
        throw new RunRefusal('target-unresolved', `$.mesh.local[${i}]: edge sizes are not applied`);
      return resolveFace(l.target.ref, `$.mesh.local[${i}]`);
    });
  } catch (e) {
    if (e instanceof RunRefusal) return failed(e.code, e.message);
    throw e;
  }
  // CR5b: the taken spot weld rows' points, and a finer size on their flanges.
  const weldPoints = new Map<string, number[]>();
  /** CR5e-2: each welded body's weld points (x, y, z each), sized around them. */
  const weldAt = new Map<string, number[]>();
  if (doc.spotWelds?.length) {
    if (!env.spotWelds) return failed('spot-weld', 'spot weld points cannot be made here');
    const placed = await env.spotWelds(cad);
    const rows = new Map(placed.rows.map((r) => [r.id, r]));
    // Codex on #976: a body's table is the one given, else the evaluation's, so its welded
    // flanges are sized whether or not the caller gave the display tables.
    const tableOf = (bodyId: string) =>
      bodyId === doc.source.bodyId ? table : (bodyTables?.get(bodyId) ?? placed.tables.get(bodyId));
    const faceOf = (bodyId: string, ref: CadTopologyRef) => {
      const own = tableOf(bodyId);
      const at = own && resolveTopologyRef(own, ref);
      return at?.status === 'resolved' ? at.index : undefined;
    };
    for (const w of doc.spotWelds) {
      const row = rows.get(w.weldId);
      if (!row) return failed('spot-weld', `${w.id}: no spot weld row ${w.weldId} in the version`);
      if (row.status !== 'ok') return failed('spot-weld', `${w.id}: ${row.code}`);
      if (!row.points.length) return failed('spot-weld', `${w.id}: the row has no point`);
      // Codex on #976: the row must still join the faces the weld took (a version may give the
      // same row ID other flanges); otherwise it is taken again.
      const cadRow = cad.spotWelds?.find((r) => r.id === w.weldId);
      const same = (t: SimulationTarget, f: { bodyId: string; face: CadTopologyRef }) => {
        const bodyId = t.body ?? doc.source.bodyId;
        const mine = faceOf(bodyId, t.ref);
        return bodyId === f.bodyId && mine !== undefined && mine === faceOf(f.bodyId, f.face);
      };
      if (!cadRow || !same(w.follower[0]!, cadRow.flanges[0]) || !same(w.on[0]!, cadRow.flanges[1]))
        return failed(
          'spot-weld',
          `${w.id}: row ${w.weldId} of the version joins other faces than the weld took: take it again`,
        );
      weldPoints.set(w.id, row.points);
      for (const t of [...w.follower, ...w.on]) {
        const bodyId = t.body ?? doc.source.bodyId;
        weldAt.set(bodyId, [...(weldAt.get(bodyId) ?? []), ...row.points]);
      }
    }
  }
  /** A body's local face sizes at a level: the source's own (CR5e-2: welds size around points). */
  const bodyFaceSizes = (bodyId: string, settings: SimulationMeshSettings) =>
    bodyId === doc.source.bodyId ? levelFaceSizes(localFaces, settings) : [];
  /**
   * CR5e-2: the size around a body's weld points at a level: 10 mm or finer within the weld's
   * radius band, refined with the level as a local size is, growing to the body's size beyond it.
   */
  const bodyPointSizes = (bodyId: string, settings: SimulationMeshSettings) => {
    const points = weldAt.get(bodyId);
    if (!points?.length) return {};
    return {
      pointSizes: {
        points,
        radiusMm: spotWeldBandMm,
        maxEdgeMm: Math.min(settings.size, (spotWeldLocalSizeMm * settings.size) / doc.mesh.size),
      },
    };
  };
  const preparation = {
    removeHolesBelow: doc.preparation.removeHolesBelow,
    removeFilletsBelow: doc.preparation.removeFilletsBelow,
    removeFaces: [...new Set(removeFaces)].sort((a, b) => a - b),
  };
  const context = {
    versionId: doc.source.versionId,
    preparationHash: simulationPreparationHash(doc.preparation),
    kernelBuild: env.builds.kernel,
  };
  const settingsList = convergenceLevelSettings(doc.mesh, study.convergence.levels);
  // Thermal studies are solved in the browser only (A2); a modal one there on smaller meshes.
  if (env.remote && study.kind === 'thermal')
    return failed('host', `a ${study.kind} study is solved in the browser, not on a compute Host`);
  // CR5e: a sheet body is a shell on itself, at the document's thickness (`checkSimulationSource`
  // refuses one without).
  const sheetMm = (bodyId: string) =>
    cad.bodies.find((b) => b.id === bodyId)?.kind === 'sheet'
      ? doc.sheets?.find((t) => t.bodyId === bodyId)?.thicknessMm
      : undefined;
  const sheetRequest = (bodyId: string) => {
    const t = sheetMm(bodyId);
    return t === undefined ? {} : { sheetThicknessMm: t };
  };
  const sourceSheet = sheetMm(doc.source.bodyId) !== undefined;
  if (
    study.kind === 'thermal' &&
    (sourceSheet || others.some((b) => sheetMm(b.bodyId) !== undefined))
  )
    return failed('source', 'a sheet body is solved as a shell, which a thermal study is not');
  // R3i-4: shells too (A3-U3).
  const shell = study.kind !== 'thermal' && (study.idealisation === 'shell' || sourceSheet);
  // R3j-5c: a modal study on a Host that solves its kind of model.
  if (
    env.remote &&
    study.kind === 'modal' &&
    !(bonded
      ? env.remote.solveBondedModal
      : shell
        ? env.remote.solveShellModal
        : env.remote.solveModal)
  )
    return failed(
      'host',
      `${env.remote.name} does not solve modal studies of ${bonded ? 'bonded bodies' : shell ? 'shells' : 'solids'}`,
    );
  // Bonded bodies go through `solveBonded` alone, shells among them.
  if (env.remote && shell && !bonded && study.kind === 'linear-static' && !env.remote.solveShell)
    return failed('host', `${env.remote.name} does not solve shells`);
  if (study.kind === 'thermal' && !(material.conductivity !== undefined))
    return failed('material-missing', `${material.name} has no thermal conductivity`);
  const limits =
    env.remote?.limits ??
    (study.kind === 'modal'
      ? {
          nodes: simulationLimits.browserModalNodes,
          elements: simulationLimits.browserModalElements,
        }
      : { nodes: simulationLimits.browserNodes, elements: simulationLimits.browserElements });
  const loads = study.loadIds.map((id) => doc.loads.find((l) => l.id === id)!);
  const constraints = study.constraintIds.map((id) => doc.constraints.find((c) => c.id === id)!);

  for (let level = 0; level < settingsList.length; level++) {
    const settings = settingsList[level]!;
    const step = (s: RunProgress['step']) =>
      env.checkpoint?.({
        level,
        levels: settingsList.length,
        step: s,
        ...(s === 'solve' && env.remote ? { on: env.remote.name } : {}),
      });
    if (bonded) {
      const request = {
        deflectionMm: runDeflectionMm(settings.minSize),
        clampDeflection: true,
        maxEdgeMm: settings.size,
      };
      const idealisation = (bodyId: string, own?: 'solid' | 'shell') =>
        sheetMm(bodyId) !== undefined
          ? 'shell'
          : (own ?? (study.kind !== 'thermal' ? study.idealisation : undefined) ?? 'solid');
      const remote = env.remote;
      let out: Awaited<ReturnType<typeof runBondedLevel>>;
      try {
        out = await runBondedLevel({
          doc,
          cad,
          kind: study.kind === 'modal' ? 'modal' : 'linear-static',
          modes: study.kind === 'modal' ? study.modes : 0,
          bodies: [
            {
              bodyId: doc.source.bodyId,
              material,
              idealisation: idealisation(doc.source.bodyId),
              table,
              request: {
                ...request,
                bodyId: doc.source.bodyId,
                ...sheetRequest(doc.source.bodyId),
                faceSizes: bodyFaceSizes(doc.source.bodyId, settings),
                ...bodyPointSizes(doc.source.bodyId, settings),
                preparation,
              },
            },
            ...others.map((b) => ({
              bodyId: b.bodyId,
              material: b.material!,
              idealisation: idealisation(b.bodyId, b.idealisation),
              ...(bodyTables?.has(b.bodyId) ? { table: bodyTables.get(b.bodyId)! } : {}),
              request: {
                ...request,
                bodyId: b.bodyId,
                ...sheetRequest(b.bodyId),
                // Removals and local sizes are the source body's; the thresholds apply to every
                // body, and every body is sized around its weld points (CR5b, CR5e-2).
                faceSizes: bodyFaceSizes(b.bodyId, settings),
                ...bodyPointSizes(b.bodyId, settings),
                preparation: { ...preparation, removeFaces: [] },
              },
            })),
          ],
          solver: study.solver,
          loads,
          constraints,
          weldPoints,
          settings,
          limits,
          ...(remote
            ? { remote: levelRemote(remote, remote.solveBonded, remote.solveBondedModal) }
            : {}),
          context,
          surface: env.surface,
          mesh: env.mesh,
          sameTable,
          surfaceVolume,
          step,
        });
      } catch (e) {
        if (e instanceof RunRefusal) return failed(e.code, e.message, level);
        throw e;
      }
      mapping = out.mapping;
      if ('failure' in out) return failed(out.failure.code, out.failure.detail, level);
      levels.push({
        settings,
        nodes: out.nodes,
        elements: out.elements,
        metrics: out.metrics,
        checks: out.checks,
      });
      fields = out.fields;
      measureTest();
      continue;
    }
    if (shell) {
      const remote = env.remote;
      let out: Awaited<ReturnType<typeof runShellLevel>>;
      try {
        out = await runShellLevel({
          doc,
          cad,
          table,
          kind: study.kind === 'modal' ? 'modal' : 'linear-static',
          modes: study.kind === 'modal' ? study.modes : 0,
          solver: study.solver,
          material,
          loads,
          constraints,
          settings,
          request: {
            bodyId: doc.source.bodyId,
            deflectionMm: runDeflectionMm(settings.minSize),
            clampDeflection: true,
            maxEdgeMm: settings.size,
            faceSizes: levelFaceSizes(localFaces, settings),
            preparation,
            ...sheetRequest(doc.source.bodyId),
          },
          limits,
          ...(remote
            ? { remote: levelRemote(remote, remote.solveShell, remote.solveShellModal) }
            : {}),
          context,
          surface: env.surface,
          sameTable,
          step,
        });
      } catch (e) {
        // The Host's own failures (`remote.solveShell` throws them as for a solid).
        if (e instanceof RunRefusal) return failed(e.code, e.message, level);
        throw e;
      }
      mapping = out.mapping;
      if ('failure' in out) return failed(out.failure.code, out.failure.detail, level);
      levels.push({
        settings,
        nodes: out.nodes,
        elements: out.elements,
        metrics: out.metrics,
        checks: out.checks,
      });
      fields = out.fields;
      measureTest();
      continue;
    }
    await step('surface');
    const result = await env.surface(cad, {
      bodyId: doc.source.bodyId,
      deflectionMm: runDeflectionMm(settings.minSize),
      clampDeflection: true,
      maxEdgeMm: settings.size,
      minEdgeMm: settings.minSize,
      faceSizes: levelFaceSizes(localFaces, settings),
      preparation,
    });
    if (!('surface' in result)) return failed('surface', result.code, level);
    const surface = result.surface;
    if (!sameTable(surface.bodyTopology, table))
      return failed('table-mismatch', 'the kernel evaluated another body table', level);

    // Before meshing: even regular tetrahedra of the global size would be over the limit (local
    // sizes and grading only refine, so this is a lower bound), so Netgen is not left to fill
    // the solid for minutes only to be refused afterwards.
    const estimate = Math.ceil(surfaceVolume(surface) / ((settings.size ** 3 * Math.SQRT2) / 12));
    if (estimate > limits.elements)
      return failed('mesh-too-large', `at least ${estimate} elements expected`, level);

    await step('mesh');
    let report: MeshReport;
    try {
      report = env.mesh(surface, {
        type: 'tet10',
        size: settings.size,
        minSize: settings.minSize,
        grading: settings.grading,
      });
    } catch (e) {
      return failed('mesh', e instanceof Error ? e.message : String(e), level);
    }
    const mesh = report.mesh;
    const nodes = mesh.nodes.length / 3;
    const elements = mesh.elements.length / 10;
    if (nodes > limits.nodes || elements > limits.elements)
      return failed('mesh-too-large', `${nodes} nodes, ${elements} elements`, level);
    // Element shape (docs/cad/r3-analysis.md, meshingと品質): one element below the limits stops
    // the run; curved tet10s are also judged by their Jacobian (straightened below the minimum).
    const shape = meshShapeQuality(mesh);
    if (shape.below.length || !(report.minJacobian > 0))
      return failed(
        'mesh-quality',
        `${shape.below.length} elements below radius ratio ${shapeQualityMin.radiusRatio} or ` +
          `dihedral ${shapeQualityMin.dihedralDeg}°; min Jacobian ratio ${report.minJacobian}`,
        level,
      );

    await step('mapping');
    const facesMeshed = new Set(mesh.boundary.tags);
    mapping = buildMapping(
      doc,
      table,
      surface.history,
      {
        faces: (tag) => facesMeshed.has(tag),
        edges: (e) => e < mesh.shapeEdges && mesh.edges.offsets[e + 1]! > mesh.edges.offsets[e]!,
      },
      context,
    );
    if (!mappingReady(mapping)) {
      const open = mapping.filter((r) => r.status !== 'resolved');
      return failed(
        'mapping',
        open.map((r) => `${r.path}: ${r.status} (${r.reason ?? r.stage})`).join('; '),
        level,
      );
    }
    const of = (owner: string, kind: 'face' | 'edge') =>
      [
        ...new Set(
          mapping.filter((r) => r.owner === owner && r.kind === kind).flatMap((r) => r.analysis),
        ),
      ].sort((a, b) => a - b);
    const { faceAreas } = surface.measures;

    if (study.kind === 'thermal') {
      const conditions = [
        ...constraints.map((c): ThermalCondition => {
          if (c.kind !== 'temperature') throw new Error('a thermal study holds temperatures only');
          return {
            kind: 'temperature',
            faces: of(c.id, 'face'),
            edges: of(c.id, 'edge'),
            temperature: c.temperature,
          };
        }),
        ...loads.map((l): ThermalCondition => {
          const faces = of(l.id, 'face');
          if (l.kind === 'heat-flux') return { kind: 'heat-flux', faces, flux: l.flux };
          if (l.kind === 'convection')
            return {
              kind: 'convection',
              faces,
              coefficient: l.coefficient,
              ambient: l.ambient,
            };
          throw new Error('a thermal study takes heat fluxes and convections only');
        }),
      ];
      await step('solve');
      let t: ThermalResult;
      try {
        t = solveThermal({
          mesh,
          material: { conductivity: material.conductivity! },
          conditions,
          solver: study.solver,
        });
      } catch (e) {
        if (e instanceof ElasticError) return failed('solve', `${e.problem}: ${e.detail}`, level);
        throw e;
      }
      await step('checks');
      // Each face condition's mesh area against the shape's; each temperature holds a node.
      const items = [...constraints, ...loads];
      const bad = items.flatMap((item, i) => {
        const c = t.conditionChecks[i]!;
        if (item.kind === 'temperature')
          return t.constrainedNodes[i] ? [] : [`${item.id} holds no node`];
        const area = of(item.id, 'face').reduce((s, f) => s + faceAreas[f]!, 0);
        const change = Math.abs(c.measure - area) / Math.max(area, 1e-300);
        return change <= loadApplicationTolerance.area
          ? []
          : [`${item.id} area: ${c.measure} mm² for ${area} mm²`];
      });
      const heatIn = items.map((item, i) => `${item.id} ${t.conditionChecks[i]!.heat} mW`);
      let maxT = -Infinity;
      let maxQ = 0;
      let maxAbsT = 0;
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let p = 0; p < nodes; p++) {
        maxT = Math.max(maxT, t.temperature[p]!);
        maxQ = Math.max(maxQ, t.fluxMagnitude[p]!);
        maxAbsT = Math.max(maxAbsT, Math.abs(t.temperature[p]!));
        for (let d = 0; d < 3; d++) {
          lo[d] = Math.min(lo[d]!, mesh.nodes[3 * p + d]!);
          hi[d] = Math.max(hi[d]!, mesh.nodes[3 * p + d]!);
        }
      }
      const balance = Math.abs(t.balance);
      const roundoff = {
        conductivity: material.conductivity!,
        diagonal: Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!),
        maxAbsTemperature: maxAbsT,
      };
      const balanced = thermalBalancePasses(balance, t.heatScale, roundoff);
      maxQ = thermalFluxMetric(maxQ, roundoff);
      levels.push({
        settings,
        nodes,
        elements,
        metrics: { 'max-temperature': maxT, 'max-heat-flux': maxQ },
        checks: [
          { name: 'mapping', pass: true, detail: `${mapping.length} targets resolved` },
          {
            name: 'load',
            pass: bad.length === 0,
            detail: bad.length ? bad.join('; ') : `${items.length} conditions applied`,
          },
          {
            name: 'quality',
            pass: report.minJacobian >= curvedJacobianMin,
            detail:
              `min radius ratio ${shape.minRadiusRatio}, min dihedral ${shape.minDihedralDeg}°, ` +
              `min Jacobian ratio ${report.minJacobian}, ${report.straightened} mid nodes straightened`,
          },
          {
            name: 'solver',
            pass: t.converged,
            detail: `${t.iterations} iterations, residual ${t.residual}`,
          },
          {
            name: 'equilibrium',
            pass: balanced,
            detail: `heat balance ${balance} mW of ${t.heatScale} mW (${heatIn.join(', ')})`,
          },
        ],
      });
      fields = {
        kind: 'thermal',
        mesh,
        temperature: t.temperature,
        flux: t.flux,
        fluxMagnitude: t.fluxMagnitude,
      };
      continue;
    }

    let elasticLoads: ElasticLoad[];
    let elasticConstraints: ElasticConstraint[];
    let masses: AddedMass[];
    try {
      ({ loads: elasticLoads, constraints: elasticConstraints } = solidConditions(
        loads,
        constraints,
        of,
        surface.measures,
      ));
      masses = addedMasses(doc.masses ?? [], of);
    } catch (e) {
      if (e instanceof ConditionRefusal) return failed(e.code, e.message, level);
      throw e;
    }

    if (study.kind === 'modal') {
      await step('solve');
      let modal: ModalResult;
      const modalInput: ModalInput = {
        mesh,
        material,
        constraints: elasticConstraints,
        masses,
        modes: study.modes,
        solver: study.solver,
      };
      try {
        modal = env.remote?.solveModal
          ? await env.remote.solveModal(modalInput)
          : solveModal(modalInput);
      } catch (e) {
        if (e instanceof RunRefusal) return failed(e.code, e.message, level);
        if (e instanceof ElasticError)
          return failed(
            'solve',
            `${e.problem}: ${e.detail}${e.modes.length ? ` (${e.modes.join(', ')})` : ''}`,
            level,
          );
        throw e;
      }
      await step('checks');
      // The mesh's mass against the analysis shape's (its volume × ρ), and every constraint
      // holding a node.
      const added = addedMassTotal(doc.masses ?? []);
      const shapeMass = surfaceVolume(surface) * material.density + added;
      const massChange = Math.abs(modal.mass - shapeMass) / Math.max(shapeMass, 1e-300);
      let k = 0;
      const empty = constraints.filter((c) => {
        const n = c.kind === 'roller' ? of(c.id, 'face').length : 1;
        const total = modal.constrainedNodes.slice(k, k + n).reduce((t, x) => t + x, 0);
        k += n;
        return total === 0;
      });
      levels.push({
        settings,
        nodes,
        elements,
        metrics: { 'first-frequency': modal.modes[0]!.frequency },
        checks: [
          { name: 'mapping', pass: true, detail: `${mapping.length} targets resolved` },
          {
            name: 'mass',
            pass: massChange <= loadApplicationTolerance.area && !empty.length,
            detail:
              `mesh ${modal.mass} t for ${shapeMass} t` +
              (added ? ` (${added} t added)` : '') +
              (empty.length ? `; ${empty.map((c) => c.id).join(', ')} hold no node` : ''),
          },
          {
            name: 'quality',
            pass: report.minJacobian >= curvedJacobianMin,
            detail:
              `min radius ratio ${shape.minRadiusRatio}, min dihedral ${shape.minDihedralDeg}°, ` +
              `min Jacobian ratio ${report.minJacobian}, ${report.straightened} mid nodes straightened`,
          },
          ...modalChecks(modal, env.remote && modalHost(env.remote)),
        ],
      });
      fields = {
        kind: 'modal',
        mesh,
        modes: modal.modes.map((m) => ({
          frequency: m.frequency,
          shape: m.shape,
          effectiveMass: m.effectiveMass,
        })),
      };
      continue;
    }

    await step('solve');
    let r: ElasticResult;
    const input: ElasticInput = {
      mesh,
      material,
      loads: elasticLoads,
      constraints: elasticConstraints,
      masses,
      solver: study.solver,
    };
    try {
      r = env.remote ? await env.remote.solve(input) : solveElastic(input);
    } catch (e) {
      if (e instanceof RunRefusal) return failed(e.code, e.message, level);
      if (e instanceof ElasticError)
        return failed(
          'solve',
          `${e.problem}: ${e.detail}${e.modes.length ? ` (${e.modes.join(', ')})` : ''}`,
          level,
        );
      throw e;
    }

    await step('checks');
    const loadInput = solidLoadInput(loads, r.loadChecks, of, surface.measures);
    const held = solidHeld(constraints, r.constrainedNodes, of);
    const loadChecks = checkLoadApplication({ loads: loadInput, constraints: held });
    const eq = equilibriumCheck(r, env.remote?.equilibrium);
    let maxU = 0;
    let maxVm = 0;
    for (let n = 0; n < nodes; n++) {
      maxVm = Math.max(maxVm, r.vonMises[n]!);
      maxU = Math.max(
        maxU,
        Math.hypot(r.displacement[3 * n]!, r.displacement[3 * n + 1]!, r.displacement[3 * n + 2]!),
      );
    }
    const bad = loadChecks.filter((c) => !c.ok);
    levels.push({
      settings,
      nodes,
      elements,
      metrics: {
        'max-displacement': maxU,
        'max-von-mises': maxVm,
        'reaction-force': Math.hypot(...r.reactionTotal),
      },
      checks: [
        { name: 'mapping', pass: true, detail: `${mapping.length} targets resolved` },
        {
          name: 'load',
          pass: bad.length === 0,
          detail: bad.length
            ? bad.map((c) => `${c.owner} ${c.quantity}: ${c.actual} for ${c.expected}`).join('; ')
            : `${loadChecks.length} checks`,
        },
        {
          name: 'quality',
          pass: report.minJacobian >= curvedJacobianMin,
          detail:
            `min radius ratio ${shape.minRadiusRatio}, min dihedral ${shape.minDihedralDeg}°, ` +
            `min Jacobian ratio ${report.minJacobian}, ${report.straightened} mid nodes straightened`,
        },
        {
          name: 'solver',
          pass: r.converged,
          detail: env.remote
            ? `direct solve by ${env.builds.solver} on ${env.remote.name}`
            : `${r.iterations} iterations, residual ${r.residual}`,
        },
        { name: 'equilibrium', pass: eq.pass, detail: `${eq.imbalance} of ${eq.scale}` },
      ],
    });
    fields = {
      mesh,
      displacement: r.displacement,
      stress: r.stress,
      vonMises: r.vonMises,
      reaction: r.reaction,
    };
    measureTest();
  }
  const last = levels[levels.length - 1]!;
  return {
    studyId,
    status: studyStatus({ study, checks: last.checks, levels: levels.map((l) => l.metrics) }),
    levels,
    mapping,
    fields,
    builds: env.builds,
  };
}

/** Where a modal run went, for its checks. */
export const modalHost = (remote: NonNullable<RunEnvironment['remote']>): ModalHost => ({
  name: remote.name,
  ...(remote.orthogonality === undefined ? {} : { orthogonality: remote.orthogonality }),
});

/** A shell or bonded level's Host: its static and modal solvers, and what their checks allow. */
function levelRemote<S, M>(
  remote: NonNullable<RunEnvironment['remote']>,
  solve: S | undefined,
  solveModal: M | undefined,
): { name: string; solve?: S; solveModal?: M; equilibrium?: number; orthogonality?: number } {
  return {
    ...modalHost(remote),
    ...(solve ? { solve } : {}),
    ...(solveModal ? { solveModal } : {}),
    ...(remote.equilibrium === undefined ? {} : { equilibrium: remote.equilibrium }),
  };
}

/** A refusal a run step gives with its own code; `remote.solve` throws it for a Host failure. */
export class RunRefusal extends Error {
  constructor(
    readonly code: RunFailureCode,
    message: string,
  ) {
    super(message);
  }
}

/** The same body table: the same faces (areas) and edges (their faces), in the same order. */
function sameTable(a: CadTopologyTable, b: CadTopologyTable) {
  const close = (x: number, y: number) =>
    Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  return (
    a.faces.length === b.faces.length &&
    a.edges.length === b.edges.length &&
    a.faces.every((f, i) => close(f.area, b.faces[i]!.area)) &&
    a.edges.every(
      (e, i) =>
        close(e.length, b.edges[i]!.length) &&
        e.faces.length === b.edges[i]!.faces.length &&
        e.faces.every((f, j) => f === b.edges[i]!.faces[j]),
    )
  );
}

/** A closed surface's enclosed volume (mm³), by the divergence theorem over its triangles. */
export function surfaceVolume(surface: Pick<CadAnalysisSurface, 'points' | 'triangles'>): number {
  const { points: p, triangles: t } = surface;
  // Relative to a point of the surface: far from the origin, world coordinates would cancel.
  const o = [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
  const at = (n: number, d: number) => p[3 * n + d]! - o[d]!;
  let six = 0;
  for (let i = 0; i < t.length; i += 3) {
    const [a, b, c] = [t[i]!, t[i + 1]!, t[i + 2]!];
    six +=
      at(a, 0) * (at(b, 1) * at(c, 2) - at(b, 2) * at(c, 1)) -
      at(a, 1) * (at(b, 0) * at(c, 2) - at(b, 2) * at(c, 0)) +
      at(a, 2) * (at(b, 0) * at(c, 1) - at(b, 1) * at(c, 0));
  }
  return Math.abs(six) / 6;
}

/**
 * The kernel's face sizes for one level: `faces[i]` is the face `settings.local[i]` sizes (resolved
 * once on the body table), at that level's refined size; the smallest wins on a face named twice.
 */
/** CR5b: the element size (mm) around a spot weld at most, so a weld has nodes near it. */
export const spotWeldLocalSizeMm = 10;
/**
 * CR5e-2: how far (mm) from a weld point that size holds (the 3 mm tie radius and a margin);
 * beyond, the size grows by the distance. A whole welded panel was sized before (F29: Host 2.1M
 * nodes at 30 mm).
 */
export const spotWeldBandMm = 5;

export function levelFaceSizes(
  faces: readonly number[],
  settings: Pick<SimulationMeshSettings, 'local'>,
): { face: number; maxEdgeMm: number }[] {
  const sizes = new Map<number, number>();
  faces.forEach((face, i) =>
    sizes.set(face, Math.min(settings.local[i]!.size, sizes.get(face) ?? Infinity)),
  );
  return [...sizes].map(([face, maxEdgeMm]) => ({ face, maxEdgeMm }));
}
