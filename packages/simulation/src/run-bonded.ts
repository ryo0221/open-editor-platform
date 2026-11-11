import type { CadDocument, CadTopologyTable } from '@editor-platform/cad-core';
import type {
  CadAnalysisSurface,
  CadAnalysisSurfaceRequest,
} from '@editor-platform/cad-kernel-occt';
import type { MeshReport, MesherSettings } from '@editor-platform/fem-mesher';
import {
  ElasticError,
  spotWeldNodes,
  curvedJacobianMin,
  meshShapeQuality,
  shapeQualityMin,
  repairShellMesh,
  shellMeshFromSurface,
  shellRepairNote,
  shellSliverPlaces,
  shellExpansionSize,
  shellMeshQuality,
  shellQualityMin,
  solveBonded,
  solveBondedModal,
  type Bond,
  type BondedInput,
  type BondedModalInput,
  type BondedModalResult,
  type BondedPart,
  type BondedResult,
  type FemMesh,
  type ShellMesh,
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
  type SimulationDocument,
  type SimulationLoad,
  type SimulationMass,
  type SimulationMaterial,
  type SimulationMeshSettings,
  type SimulationMetric,
} from '@editor-platform/simulation-core';
import {
  addedMasses,
  addedMassTotal,
  modalChecks,
  ConditionRefusal,
  shellConditions,
  shellLoadInput,
  solidConditions,
  solidHeld,
  solidLoadInput,
  type TargetsOf,
} from './run-conditions';
import type { ModalRunFields } from './run';
import type { ShellModalRunFields, ShellStaticRunFields } from './run-shell';

/**
 * R3j-4b (docs/cad/r3-analysis.md, A4): one level of a linear static study of several bodies of
 * one CAD version joined by the document's bonds. Each body gets its own analysis surface, mesh
 * (a tet10 solid, or a shell on its midsurface), mapping table and conditions; `solveBonded`
 * solves them together. A bond side on a shell is followed on the midsurface, half the wall's
 * thickness from the CAD face, so the run adds that to the bond's tolerance. The checks are a
 * one-body run's over all bodies: mapping (with each bond's tied nodes and gap), load, quality,
 * solver and equilibrium (forces and moments of all bodies together).
 */
export interface BondedStaticRunFields {
  kind: 'bonded-static';
  /** Each body's fields, the source body first. */
  bodies: { bodyId: string; fields: SolidBodyFields | ShellStaticRunFields }[];
}
/** R3j-4c: each body's modes; a mode's frequency and effective masses are of all bodies. */
export interface BondedModalRunFields {
  kind: 'bonded-modal';
  bodies: { bodyId: string; fields: ModalRunFields | ShellModalRunFields }[];
}
export interface SolidBodyFields {
  kind?: 'linear-static';
  mesh: FemMesh;
  displacement: Float64Array;
  stress: Float64Array;
  vonMises: Float64Array;
  reaction: Float64Array;
}

export interface BondedBody {
  bodyId: string;
  material: SimulationMaterial;
  idealisation: 'solid' | 'shell';
  /** The body's display table; the kernel's is taken when absent (a body the caller has none of). */
  table?: CadTopologyTable;
  /** The surface request of the level, without the idealisation and the minimum size. */
  request: Omit<CadAnalysisSurfaceRequest, 'idealisation' | 'minEdgeMm'>;
}

export type BondedLevelFailure = {
  code:
    | 'surface'
    | 'table-mismatch'
    | 'mesh'
    | 'mesh-too-large'
    | 'mesh-quality'
    | 'mapping'
    | 'shell-target'
    | 'load-targets-mixed'
    | 'roller-direction'
    | 'spot-weld'
    | 'solve';
  detail: string;
};

export interface BondedLevelInput {
  doc: SimulationDocument;
  cad: CadDocument;
  bodies: BondedBody[];
  kind: 'linear-static' | 'modal';
  modes: number;
  solver: { tolerance: number; maxIterations: number };
  loads: SimulationLoad[];
  constraints: SimulationConstraint[];
  /** CR5b: each taken spot weld row's points (x, y, z on its first flange), by its ID. */
  weldPoints?: ReadonlyMap<string, readonly number[]>;
  settings: SimulationMeshSettings;
  /** For all bodies together (on a Host: as sent, a shell as its wedges). */
  limits: { nodes: number; elements: number };
  /**
   * R3j-5b: a static study solved on a compute Host instead (`solveBondedOnHost`), with the
   * imbalance its 6-digit results allow.
   */
  remote?: {
    name: string;
    solve?(input: BondedInput): Promise<BondedResult>;
    /** R3j-5c: a modal study on the Host (`solveBondedModalOnHost`), checked by `modalChecks`. */
    solveModal?(input: BondedModalInput): Promise<BondedModalResult>;
    equilibrium?: number;
    orthogonality?: number;
  };
  context: MappingContext;
  surface(
    cad: CadDocument,
    request: CadAnalysisSurfaceRequest,
  ): Promise<{ surface: CadAnalysisSurface } | { code: string; detail?: string }>;
  mesh(surface: CadAnalysisSurface, settings: MesherSettings): MeshReport;
  sameTable(a: CadTopologyTable, b: CadTopologyTable): boolean;
  surfaceVolume(surface: CadAnalysisSurface): number;
  step(s: 'surface' | 'mesh' | 'mapping' | 'solve' | 'checks'): Promise<void> | void;
}

export type BondedLevelResult =
  | {
      nodes: number;
      elements: number;
      metrics: Partial<Record<SimulationMetric, number>>;
      checks: RunCheck[];
      mapping: MappingRow[];
      fields: BondedStaticRunFields | BondedModalRunFields;
    }
  | { failure: BondedLevelFailure; mapping: MappingRow[] };

type Prepared = { body: BondedBody; surface: CadAnalysisSurface; quality: RunCheck } & (
  | { kind: 'solid'; mesh: FemMesh }
  | { kind: 'shell'; mesh: ShellMesh; thickness: number }
);

export async function runBondedLevel(input: BondedLevelInput): Promise<BondedLevelResult> {
  let mapping: MappingRow[] = [];
  const fail = (code: BondedLevelFailure['code'], detail: string): BondedLevelResult => ({
    failure: { code, detail },
    mapping,
  });
  const { doc, settings } = input;
  const prepared: Prepared[] = [];
  let nodes = 0,
    elements = 0;
  /** What a Host gets: a shell as its wedges. */
  let sentNodes = 0;
  // The Host, if it solves this kind of study.
  const remote = (input.kind === 'modal' ? input.remote?.solveModal : input.remote?.solve)
    ? input.remote
    : undefined;

  for (const body of input.bodies) {
    const name = body.bodyId;
    await input.step('surface');
    const shell = body.idealisation === 'shell';
    const result = await input.surface(input.cad, {
      ...body.request,
      ...(shell ? { idealisation: 'shell' as const } : { minEdgeMm: settings.minSize }),
    });
    if (!('surface' in result))
      return fail(
        'surface',
        `${name}: ${result.detail ? `${result.code}: ${result.detail}` : result.code}`,
      );
    const surface = result.surface;
    if (body.table && !input.sameTable(surface.bodyTopology, body.table))
      return fail('table-mismatch', `${name}: the kernel evaluated another body table`);

    await input.step('mesh');
    if (shell) {
      if (!surface.shell) return fail('surface', `${name}: the kernel gave no midsurface`);
      const sides = (body.request.faceSizes ?? [])
        .map((s) => s.face)
        .filter((f) => surface.history.faces[f]?.deleted);
      if (sides.length)
        return fail(
          'shell-target',
          `${name}: a finer size on a side face of the wall (body face ${sides.join(', ')}) is not applied to a shell`,
        );
      let mesh: ShellMesh;
      let mended = '';
      try {
        // CR1a: mend the slivers the kernel's triangulation leaves where shallow chains meet.
        const repair = repairShellMesh(shellMeshFromSurface(surface, surface.shell.thicknessMm));
        mesh = repair.mesh;
        mended = shellRepairNote(repair);
      } catch (e) {
        return fail('mesh', `${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
      nodes += mesh.nodes.length / 3;
      elements += mesh.triangles.length / 3;
      sentNodes += remote ? shellExpansionSize(mesh).nodes : mesh.nodes.length / 3;
      if (sentNodes > input.limits.nodes || elements > input.limits.elements)
        return fail(
          'mesh-too-large',
          `${nodes} nodes, ${elements} elements with ${name}${remote ? ` (${sentNodes} nodes as wedges on ${remote.name})` : ''}`,
        );
      const q = shellMeshQuality(mesh);
      const detail =
        `${name}: min angle ${q.minAngleDeg}°, max aspect ratio ${q.maxAspect}, ` +
        `thickness ${surface.shell.thicknessMm} mm${mended}`;
      if (q.below.length)
        return fail(
          'mesh-quality',
          `${q.below.length} triangles below ${shellQualityMin.minAngleDeg}° or above aspect ` +
            `${shellQualityMin.maxAspect} at ${shellSliverPlaces(mesh, q.below)}; ${detail}`,
        );
      prepared.push({
        body,
        surface,
        kind: 'shell',
        mesh,
        thickness: surface.shell.thicknessMm,
        quality: { name: 'quality', pass: true, detail },
      });
      continue;
    }
    const estimate = Math.ceil(
      input.surfaceVolume(surface) / ((settings.size ** 3 * Math.SQRT2) / 12),
    );
    if (elements + estimate > input.limits.elements)
      return fail('mesh-too-large', `at least ${elements + estimate} elements expected`);
    let report: MeshReport;
    try {
      report = input.mesh(surface, {
        type: 'tet10',
        size: settings.size,
        minSize: settings.minSize,
        grading: settings.grading,
      });
    } catch (e) {
      return fail('mesh', `${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const mesh = report.mesh;
    nodes += mesh.nodes.length / 3;
    elements += mesh.elements.length / 10;
    sentNodes += mesh.nodes.length / 3;
    if (sentNodes > input.limits.nodes || elements > input.limits.elements)
      return fail('mesh-too-large', `${nodes} nodes, ${elements} elements with ${name}`);
    const shape = meshShapeQuality(mesh);
    if (shape.below.length || !(report.minJacobian > 0))
      return fail(
        'mesh-quality',
        `${name}: ${shape.below.length} elements below radius ratio ${shapeQualityMin.radiusRatio} or ` +
          `dihedral ${shapeQualityMin.dihedralDeg}°; min Jacobian ratio ${report.minJacobian}`,
      );
    prepared.push({
      body,
      surface,
      kind: 'solid',
      mesh,
      quality: {
        name: 'quality',
        pass: report.minJacobian >= curvedJacobianMin,
        detail:
          `${name}: min radius ratio ${shape.minRadiusRatio}, min dihedral ${shape.minDihedralDeg}°, ` +
          `min Jacobian ratio ${report.minJacobian}, ${report.straightened} mid nodes straightened`,
      },
    });
  }

  // Each body's targets on its own table and mesh.
  await input.step('mapping');
  const rowsOf: MappingRow[][] = prepared.map((p) => {
    const m = p.mesh;
    const faces = new Set(p.kind === 'shell' ? p.mesh.faces : p.mesh.boundary.tags);
    return buildMapping(
      doc,
      p.body.table ?? p.surface.bodyTopology,
      p.kind === 'shell' ? { ...p.surface.history, midsurface: true } : p.surface.history,
      {
        faces: (tag) => faces.has(tag),
        edges: (e) => e < m.shapeEdges && m.edges.offsets[e + 1]! > m.edges.offsets[e]!,
      },
      input.context,
      { bodyId: p.body.bodyId },
    ).map((r) => ({ ...r, body: p.body.bodyId }));
  });
  mapping = rowsOf.flat();
  if (!mappingReady(mapping)) {
    const open = mapping.filter((r) => r.status !== 'resolved');
    return fail(
      'mapping',
      open.map((r) => `${r.body} ${r.path}: ${r.status} (${r.reason ?? r.stage})`).join('; '),
    );
  }
  const targetsOf =
    (rows: MappingRow[]): TargetsOf =>
    (owner, kind, reversed) =>
      [
        ...new Set(
          rows
            .filter(
              (r) =>
                r.owner === owner &&
                (r.as ?? r.kind) === kind &&
                (reversed === undefined || !!r.reversed === reversed),
            )
            .flatMap((r) => r.analysis),
        ),
      ].sort((a, b) => a - b);
  const ofs = rowsOf.map(targetsOf);
  const has = (i: number, owner: string) => rowsOf[i]!.some((r) => r.owner === owner);

  // Each body's loads (gravity on every body) and constraints. A force is a total: spread over
  // several bodies it has no share for each, so it is refused.
  const loadsOn = prepared.map(() => [] as SimulationLoad[]);
  for (const l of input.loads) {
    const on = prepared.flatMap((_, i) => (l.kind === 'gravity' || has(i, l.id) ? [i] : []));
    if (l.kind === 'force' && on.length > 1)
      return fail(
        'load-targets-mixed',
        `${l.id}: a force on ${on.length} bodies; give each body its own force`,
      );
    for (const i of on) loadsOn[i]!.push(l);
  }
  const constraintsOn = prepared.map((_, i) => input.constraints.filter((c) => has(i, c.id)));
  // CR5a: an added mass is a total too, so it stays on one body.
  const massesOn = prepared.map(() => [] as SimulationMass[]);
  for (const mass of doc.masses ?? []) {
    const on = prepared.flatMap((_, i) => (has(i, mass.id) ? [i] : []));
    if (on.length > 1)
      return fail(
        'load-targets-mixed',
        `${mass.id}: an added mass on ${on.length} bodies; give each body its own mass`,
      );
    for (const i of on) massesOn[i]!.push(mass);
  }
  let parts: BondedPart[];
  try {
    parts = prepared.map((p, i): BondedPart => {
      const material = p.body.material;
      if (p.kind === 'shell') {
        const c = shellConditions(loadsOn[i]!, constraintsOn[i]!, ofs[i]!);
        const masses = addedMasses(massesOn[i]!, ofs[i]!);
        return { kind: 'shell', mesh: p.mesh, material, ...c, masses };
      }
      const c = solidConditions(loadsOn[i]!, constraintsOn[i]!, ofs[i]!, p.surface.measures);
      const masses = addedMasses(massesOn[i]!, ofs[i]!);
      return { kind: 'solid', mesh: p.mesh, material, ...c, masses };
    });
  } catch (e) {
    if (e instanceof ConditionRefusal) return fail(e.code, e.message);
    throw e;
  }

  // The bonds: each side on its body's analysis faces and edges.
  const weldTies: ReturnType<typeof spotWeldNodes>[] = [];
  const bonds: Bond[] = (doc.bonds ?? []).map((b, bi) => {
    const side = (which: 'follower' | 'on') => {
      const bodyId = b[which][0]?.body ?? doc.source.bodyId;
      const part = prepared.findIndex((p) => p.body.bodyId === bodyId);
      const rows = (rowsOf[part] ?? []).filter((r) =>
        r.path.startsWith(`$.bonds[${bi}].${which}[`),
      );
      const of = (kind: 'face' | 'edge') =>
        [...new Set(rows.filter((r) => (r.as ?? r.kind) === kind).flatMap((r) => r.analysis))].sort(
          (x, y) => x - y,
        );
      return { part, faces: of('face'), edges: of('edge') };
    };
    const follower = side('follower'),
      on = side('on');
    const allowance = [follower.part, on.part].reduce((s, k) => {
      const p = prepared[k];
      return s + (p?.kind === 'shell' ? p.thickness / 2 : 0);
    }, 0);
    return {
      follower,
      on,
      tolerance: b.tolerance + allowance,
      ...(b.contact ? { contact: true } : {}),
    };
  });
  // CR5b: each spot weld row, a bond of its first flange's nodes near its points onto the second.
  const welds = doc.spotWelds ?? [];
  for (const [wi, w] of welds.entries()) {
    const side = (which: 'follower' | 'on') => {
      const bodyId = w[which][0]?.body ?? doc.source.bodyId;
      const part = prepared.findIndex((p) => p.body.bodyId === bodyId);
      const rows = (rowsOf[part] ?? []).filter((r) =>
        r.path.startsWith(`$.spotWelds[${wi}].${which}[`),
      );
      const faces = [
        ...new Set(rows.filter((r) => (r.as ?? r.kind) === 'face').flatMap((r) => r.analysis)),
      ];
      if (rows.some((r) => (r.as ?? r.kind) !== 'face'))
        return `${w.id}: a flange on a wall's side face (an edge of the midsurface)`;
      return { part, faces: faces.sort((x, y) => x - y), edges: [] as number[] };
    };
    const follower = side('follower'),
      on = side('on');
    if (typeof follower === 'string') return fail('spot-weld', follower);
    if (typeof on === 'string') return fail('spot-weld', on);
    if (follower.part === on.part)
      return fail('spot-weld', `${w.id}: both flanges are on one body`);
    const fp = prepared[follower.part]!;
    let tied: ReturnType<typeof spotWeldNodes>;
    try {
      tied = spotWeldNodes(
        fp.kind === 'shell' ? { kind: 'shell', mesh: fp.mesh } : { kind: 'solid', mesh: fp.mesh },
        follower.faces,
        input.weldPoints?.get(w.id) ?? [],
        w.radiusMm,
      );
    } catch (e) {
      if (e instanceof ElasticError) return fail('spot-weld', `${w.id}: ${e.problem}: ${e.detail}`);
      throw e;
    }
    const allowance = [follower.part, on.part].reduce((s, k) => {
      const p = prepared[k]!;
      return s + (p.kind === 'shell' ? p.thickness / 2 : 0);
    }, 0);
    weldTies.push(tied);
    bonds.push({
      follower: { ...follower, nodes: tied.nodes },
      on,
      tolerance: w.tolerance + allowance,
    });
  }

  const solveFailure = (e: unknown) => {
    if (e instanceof ElasticError)
      return fail(
        'solve',
        `${e.problem}: ${e.detail}${e.modes.length ? ` (${e.modes.join(', ')})` : ''}`,
      );
    throw e;
  };
  const bondDetail = (stats: { nodes: number; maxGap: number }[]) => {
    const n = doc.bonds?.length ?? 0;
    return [
      ...(doc.bonds ?? []).map(
        (b, i) => `${b.name} ties ${stats[i]!.nodes} nodes, gap ${stats[i]!.maxGap} mm`,
      ),
      // CR5b: a weld row's points, and how many fell back on the nearest element face.
      ...welds.map((w, i) => {
        const t = weldTies[i]!;
        const fallback = t.points.filter((p) => p.fallback).length;
        return (
          `${w.name}: ${t.points.length} welds tie ${stats[n + i]!.nodes} nodes, gap ${stats[n + i]!.maxGap} mm` +
          (fallback ? ` (${fallback} on the nearest element, none within ${w.radiusMm} mm)` : '')
        );
      }),
    ].join('; ');
  };
  const mappingCheck = (stats: { nodes: number; maxGap: number }[]): RunCheck => {
    const bonds = bondDetail(stats);
    return {
      name: 'mapping',
      pass: true,
      detail: `${mapping.length} targets resolved on ${prepared.length} bodies${bonds ? `; ${bonds}` : ''}`,
    };
  };
  const qualityCheck: RunCheck = {
    name: 'quality',
    pass: prepared.every((p) => p.quality.pass),
    detail: prepared.map((p) => p.quality.detail).join('; '),
  };

  if (input.kind === 'modal') {
    await input.step('solve');
    let m: BondedModalResult;
    try {
      const modalInput: BondedModalInput = {
        parts,
        bonds,
        modes: input.modes,
        solver: input.solver,
      };
      m = remote?.solveModal ? await remote.solveModal(modalInput) : solveBondedModal(modalInput);
    } catch (e) {
      return solveFailure(e);
    }
    await input.step('checks');
    // Each body's mesh mass against its shape's: the volume × ρ (solid), ρ t × the midsurface's
    // area (shell), plus its added masses (CR5a); and every constraint holding a node somewhere.
    const masses = prepared.map((p, i) => {
      const rho = p.body.material.density;
      const shape =
        (p.kind === 'shell'
          ? rho * p.thickness * Array.from(p.surface.measures.faceAreas).reduce((s, a) => s + a, 0)
          : rho * input.surfaceVolume(p.surface)) + addedMassTotal(massesOn[i]!);
      const mesh = m.partMasses[i]!;
      return {
        bodyId: p.body.bodyId,
        mesh,
        shape,
        ok: Math.abs(mesh - shape) <= loadApplicationTolerance.area * Math.max(shape, 1e-300),
      };
    });
    const heldBy = new Map<string, number>();
    prepared.forEach((p, i) => {
      const counts =
        p.kind === 'shell'
          ? constraintsOn[i]!.map((c, k) => ({ owner: c.id, nodes: m.constrainedNodes[i]![k]! }))
          : solidHeld(constraintsOn[i]!, m.constrainedNodes[i]!, ofs[i]!);
      for (const c of counts) heldBy.set(c.owner, (heldBy.get(c.owner) ?? 0) + c.nodes);
    });
    const empty = input.constraints.filter((c) => !heldBy.get(c.id));
    return {
      nodes,
      elements,
      mapping,
      metrics: { 'first-frequency': m.modes[0]!.frequency },
      checks: [
        mappingCheck(m.bonds),
        {
          name: 'mass',
          pass: masses.every((x) => x.ok) && !empty.length,
          detail:
            masses.map((x) => `${x.bodyId} mesh ${x.mesh} t for ${x.shape} t`).join('; ') +
            (empty.length ? `; ${empty.map((c) => c.id).join(', ')} hold no node` : ''),
        },
        qualityCheck,
        ...modalChecks(
          m,
          remote,
          `, ${m.dofs} DOFs after the bonds${remote ? ' (shells as 15-node wedges)' : ''}`,
        ),
      ],
      fields: {
        kind: 'bonded-modal',
        bodies: prepared.map((p, i) => {
          const modes = m.modes.map((x) => ({
            frequency: x.frequency,
            shape: x.shapes[i]!,
            effectiveMass: x.effectiveMass,
          }));
          return {
            bodyId: p.body.bodyId,
            fields:
              p.kind === 'shell'
                ? { kind: 'shell-modal' as const, mesh: p.mesh, modes }
                : { kind: 'modal' as const, mesh: p.mesh, modes },
          };
        }),
      },
    };
  }

  await input.step('solve');
  let r: BondedResult;
  try {
    r = remote?.solve
      ? await remote.solve({ parts, bonds, solver: input.solver })
      : solveBonded({ parts, bonds, solver: input.solver });
  } catch (e) {
    return solveFailure(e);
  }

  await input.step('checks');
  const loadInput = prepared.flatMap((p, i) =>
    (p.kind === 'shell' ? shellLoadInput : solidLoadInput)(
      loadsOn[i]!,
      r.parts[i]!.loadChecks,
      ofs[i]!,
      p.surface.measures,
    ),
  );
  const heldBy = new Map<string, number>();
  prepared.forEach((p, i) => {
    const counts =
      p.kind === 'shell'
        ? constraintsOn[i]!.map((c, k) => ({
            owner: c.id,
            nodes: r.parts[i]!.constrainedNodes[k]!,
          }))
        : solidHeld(constraintsOn[i]!, r.parts[i]!.constrainedNodes, ofs[i]!);
    for (const c of counts) heldBy.set(c.owner, (heldBy.get(c.owner) ?? 0) + c.nodes);
  });
  const loadChecks = checkLoadApplication({
    loads: loadInput,
    constraints: input.constraints.map((c) => ({ owner: c.id, nodes: heldBy.get(c.id) ?? 0 })),
  });
  const bad = loadChecks.filter((c) => !c.ok);

  // Equilibrium of all bodies together: the applied loads against the reactions.
  const force = Math.hypot(...r.appliedTotal.map((x, i) => x + r.reactionTotal[i]!));
  const moment = Math.hypot(...r.appliedMoment.map((x, i) => x + r.reactionMoment[i]!));
  let reactions = 0;
  r.parts.forEach((part) => {
    const per = part.kind === 'shell' ? 6 : 3;
    for (let n = 0; n < part.reaction.length / per; n++)
      reactions += Math.hypot(
        part.reaction[per * n]!,
        part.reaction[per * n + 1]!,
        part.reaction[per * n + 2]!,
      );
  });
  const forceScale = Math.max(Math.hypot(...r.appliedTotal), reactions, r.forceScale ?? 0);
  const relative = remote?.equilibrium ?? 1e-6;
  const balanced = force <= relative * forceScale && moment <= relative * r.momentScale;

  let maxU = 0,
    maxVm = 0;
  const fields: BondedStaticRunFields['bodies'] = prepared.map((p, i) => {
    const part = r.parts[i]!;
    const per = part.kind === 'shell' ? 6 : 3;
    for (let n = 0; n < part.displacement.length / per; n++) {
      maxU = Math.max(
        maxU,
        Math.hypot(
          part.displacement[per * n]!,
          part.displacement[per * n + 1]!,
          part.displacement[per * n + 2]!,
        ),
      );
      maxVm = Math.max(maxVm, part.kind === 'shell' ? part.vonMises.max[n]! : part.vonMises[n]!);
    }
    const bodyId = p.body.bodyId;
    if (p.kind === 'shell' && part.kind === 'shell')
      return {
        bodyId,
        fields: {
          kind: 'shell-static',
          mesh: p.mesh,
          displacement: part.displacement,
          stress: part.stress,
          vonMises: part.vonMises,
          reaction: part.reaction,
        },
      };
    if (p.kind === 'solid' && part.kind === 'solid')
      return {
        bodyId,
        fields: {
          mesh: p.mesh,
          displacement: part.displacement,
          stress: part.stress,
          vonMises: part.vonMises,
          reaction: part.reaction,
        },
      };
    throw new Error('a bonded part came back as another kind');
  });
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
      mappingCheck(r.bonds),
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
        detail: remote
          ? `direct solve on ${remote.name}, ${r.dofs} DOFs after the bonds (shells as 15-node wedges)`
          : `${r.iterations} iterations (${r.preconditioner}), residual ${r.residual}, ${r.dofs} DOFs after the bonds`,
      },
      {
        name: 'equilibrium',
        pass: balanced,
        detail: `force ${force} of ${forceScale}, moment ${moment} of ${r.momentScale}`,
      },
    ],
    fields: { kind: 'bonded-static', bodies: fields },
  };
}
