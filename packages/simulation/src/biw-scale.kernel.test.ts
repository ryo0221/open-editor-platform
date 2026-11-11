import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  cadContentHash,
  f29Biw,
  f29Groups,
  f29Joints,
  topologyRefOf,
  type CadDocument,
  type CadTopologyTable,
} from '@editor-platform/cad-core';
import { evaluateCad, FeatureCache, type CadMesh } from '@editor-platform/cad-kernel-occt';
import { meshSurfaceReport, type FemMesherModule } from '@editor-platform/fem-mesher';
import {
  bondedHostModel,
  bondedModalHostModel,
  bondedModalResultFromFrd,
  expandShell,
  calculixModeCount,
  readCalculixModes,
  type BondedModalInput,
  type BondedModalResult,
  type CalculixModel,
  bondedResultFromFrd,
  readCalculixFrd,
  writeCalculixModel,
  type BondedResult,
  meshShapeQuality,
  shellExpansionSize,
  type BondedInput,
} from '@editor-platform/geometry-fem';
import {
  applySimulationOperation,
  emptySimulation,
  freshSimulationId,
  simulationMaterialPresets,
  type SimulationConstraint,
  type SimulationDocument,
  type SimulationStudy,
} from '@editor-platform/simulation-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { bondCandidates, candidateBond } from './bond-candidates';
import { referenceComputeLimits } from './compute';
import { spotWeldOf, type SimulationWeldRow } from './conditions';
import { runStudy, type RunEnvironment } from './run';
import { bendingTestOps, torsionTestOps } from './stiffness-test';

/**
 * TS-1578 (ST-272, CR5e, docs/cad/car-design.md): the scale of F29's analysis. Every body of the
 * simplified BIW in one study (the 36 sheets as shells of 0.8–1.6 mm, the 4 mounts as solids
 * bonded to the sheets they sit on, the 44 weld rows as spot welds), meshed at 20, 25 and 30 mm
 * with the welds' 10 mm local size; the nodes the browser meshes and the nodes the Host is sent
 * (a shell as its 15-node wedges) are counted, nothing is solved and nothing is timed.
 */
const root = path.resolve(__dirname, '../../..');
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const mesher = process.env.FEM_MESHER_DIST ?? path.join(root, 'work/fem-mesher');
const available =
  existsSync(path.join(kernel, cadKernelBuild.wasm)) &&
  existsSync(path.join(mesher, 'fem-mesher.wasm'));

/** The sheets' thicknesses (mm) by part: outer panels thin, members and pillars thicker. */
export const f29ThicknessMm: Record<string, number> = {
  floor: 0.8,
  dash: 0.8,
  trunk: 0.8,
  roof: 0.8,
  'bow-front': 1.0,
  'bow-rear': 1.0,
  side: 0.8,
  sill: 1.4,
  'pillar-a': 1.4,
  'pillar-b': 1.4,
  'pillar-c': 1.2,
  rail: 1.2,
  'front-member': 1.6,
  'front-closure': 1.6,
  'front-extension': 1.6,
  tower: 1.2,
  apron: 0.8,
  radiator: 1.0,
  'rear-member': 1.6,
  'rear-closure': 1.6,
  wheelhouse: 0.8,
  'cross-rear': 1.2,
  'cross-middle': 1.2,
  'cross-front': 1.2,
};
const sizes = (process.env.CR5E_SIZES ?? '30,25,20').split(',').map(Number);

/** What a level would send: the browser's mesh and the Host's model. */
interface Count {
  size: number;
  shellNodes: number;
  solidNodes: number;
  hostNodes: number;
  hostElements: number;
  equations: number | string;
}
class Counted extends Error {}

describe.skipIf(!available)('the scale of the simplified BIW F29 (CR5e)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let oc: any;
  let fem: FemMesherModule;
  beforeAll(async () => {
    const wasm = readFileSync(path.join(kernel, cadKernelBuild.wasm));
    expect(createHash('sha256').update(wasm).digest('hex')).toBe(cadKernelBuild.wasmSha256);
    globalThis.require ??= createRequire(import.meta.url);
    const { default: factory } = await import(
      pathToFileURL(path.join(kernel, cadKernelBuild.js)).href
    );
    oc = await factory({ wasmBinary: wasm });
    const create = (await import(pathToFileURL(path.join(mesher, 'fem-mesher.mjs')).href)) as {
      default: () => Promise<FemMesherModule>;
    };
    fem = await create.default();
  }, 300_000);

  // CR5f: where a run's time goes before the Host (reset by each measured run).
  const phases = { start: 0, surfaceMs: 0, meshMs: 0, spotWeldsMs: 0, toHostMs: 0 };
  const bodyOrder: string[] = [];
  // CR5f-5: a run's evaluations build the version once, as the run Worker's do.
  let features = new FeatureCache();
  const env = (
    counts: Count[],
    size: number,
    measured?: (input: BondedInput) => Promise<BondedResult>,
    measuredModal?: (input: BondedModalInput) => Promise<BondedModalResult>,
  ): RunEnvironment => (
    (sentCount = counter(counts, size)),
    {
      builds: { kernel: cadKernelBuild.wasmSha256, mesher: 'fem-mesher', solver: 'geometry-fem' },
      surface: async (cad, request) => {
        const t0 = performance.now();
        const r = (
          await evaluateCad(oc, cad, cadContentHash(cad), { analysisSurface: request, features })
        ).analysisSurface!;
        phases.surfaceMs += performance.now() - t0;
        bodyOrder.push(request.bodyId);
        // CR5E_BODIES=1: each body's surface (triangles) and the weld points it is sized around.
        if (process.env.CR5E_BODIES) {
          const shown =
            'surface' in r
              ? `${r.surface.triangles.length / 3} triangles of ${r.surface.bodyTopology.faces.length} faces`
              : r.code;
          console.log(
            `F29 ${size} mm ${request.bodyId}: ${shown}, ` +
              `${(request.pointSizes?.points.length ?? 0) / 3} weld points at ${request.pointSizes?.maxEdgeMm ?? '-'} mm`,
          );
        }
        return r;
      },
      // A solid whose tets fall under the quality line is meshed once more with grading 1.3 (the
      // rear mount's box at 20 and 30 mm, a CR5f finding); its few nodes do not change the count.
      mesh: (surface, settings) => {
        const t0 = performance.now();
        try {
          const r = meshSurfaceReport(fem, surface, settings);
          if (!meshShapeQuality(r.mesh).below.length) return r;
          console.log(`F29 ${size} mm: a solid remeshed with grading 1.3`);
          return meshSurfaceReport(fem, surface, { ...settings, grading: 1.3 });
        } finally {
          phases.meshMs += performance.now() - t0;
        }
      },
      spotWelds: async (cad) => {
        const t0 = performance.now();
        const { evaluation: e, meshes } = await evaluateCad(oc, cad, cadContentHash(cad), {
          features,
        });
        phases.spotWeldsMs += performance.now() - t0;
        return {
          rows: e.status === 'ok' ? (e.spotWelds ?? []) : [],
          tables: new Map(
            meshes.filter((m) => !m.lod && !m.beforeFailure).map((m) => [m.bodyId, m.topology]),
          ),
        };
      },
      // A Host without limits that only counts what it is sent.
      remote: {
        name: 'Counting Host',
        limits: { nodes: Number.MAX_SAFE_INTEGER, elements: Number.MAX_SAFE_INTEGER },
        solve: () => Promise.reject(new Error('not called')),
        solveBonded: async (input: BondedInput) => {
          sentCount(input);
          if (measured) return measured(input);
          throw new Counted('counted');
        },
        // CR5f: a modal study of the bonded bodies, counted the same way.
        solveBondedModal: async (input: BondedModalInput) => {
          sentCount({ parts: input.parts, bonds: input.bonds, solver: input.solver });
          if (measuredModal) return measuredModal(input);
          throw new Counted('counted');
        },
      },
    }
  );
  /** What a level sends the Host, appended to `counts`. */
  let sentCount: (input: BondedInput) => void = () => undefined;
  const counter = (counts: Count[], size: number) => (input: BondedInput) => {
    phases.toHostMs = performance.now() - phases.start;
    const nodes = (kind: 'shell' | 'solid') =>
      input.parts.filter((p) => p.kind === kind).reduce((n, p) => n + p.mesh.nodes.length / 3, 0);
    // What is sent: a shell as its 15-node wedges, a solid as its tet10 nodes.
    const sent = input.parts.reduce(
      (n, p) => {
        const e =
          'elements' in p.mesh
            ? { nodes: p.mesh.nodes.length / 3, elements: p.mesh.elements.length / 10 }
            : shellExpansionSize(p.mesh);
        return { nodes: n.nodes + e.nodes, elements: n.elements + e.elements };
      },
      { nodes: 0, elements: 0 },
    );
    // The Host's model with its bond equations; F29's mounts are not bonded (no candidate is
    // offered), so a model that refuses the unheld pieces leaves the equations uncounted.
    let equations: number | string;
    try {
      equations = bondedHostModel(input).model.equations?.length ?? 0;
    } catch (e) {
      equations = e instanceof Error ? e.message : String(e);
      // Which shells the Host would refuse to expand, by body (the surfaces' order).
      const refused = input.parts.flatMap((part, i) => {
        if (part.kind !== 'shell') return [];
        try {
          expandShell(part.mesh);
          return [];
        } catch (x) {
          return [`${bodyOrder[i] ?? i}: ${x instanceof Error ? x.message : String(x)}`];
        }
      });
      if (refused.length) equations += ` [${refused.join('; ')}]`;
    }
    counts.push({
      size,
      shellNodes: nodes('shell'),
      solidNodes: nodes('solid'),
      hostNodes: sent.nodes,
      hostElements: sent.elements,
      equations,
    });
  };

  /** F29's analysis: every body, the sheets' thicknesses, the mount bonds, the welds, a test. */
  const setup = async () => {
    const cad: CadDocument = f29Biw();
    const evaluated = await evaluateCad(oc, cad, cadContentHash(cad));
    if (evaluated.evaluation.status !== 'ok') throw new Error('F29 did not evaluate');
    const meshes = new Map<string, CadMesh>(
      evaluated.meshes.filter((m) => !m.lod).map((m) => [m.bodyId, m]),
    );
    const tables = new Map<string, CadTopologyTable>(
      [...meshes].map(([id, m]) => [id, m.topology]),
    );
    const named = new Map(
      cad.bodies.map((b) => [
        b.id,
        { table: tables.get(b.id)!, featureId: b.resultFeatureId, name: b.name },
      ]),
    );
    const source = 'floor';
    const mounts = f29Groups.mount;
    let doc: SimulationDocument = emptySimulation(
      { artifactId: 'f29', versionId: 'v1', contentHash: cadContentHash(cad), bodyId: source },
      'F29 simplified BIW',
    );
    doc.materials.push({ id: 'steel', ...simulationMaterialPresets[0]! });
    doc.materialId = 'steel';
    for (const b of cad.bodies) {
      if (b.id !== source)
        doc = applySimulationOperation(doc, {
          type: 'addBody',
          body: {
            bodyId: b.id,
            materialId: 'steel',
            ...(mounts.includes(b.id) ? { idealisation: 'solid' as const } : {}),
          },
        });
      if (!mounts.includes(b.id))
        doc = applySimulationOperation(doc, {
          type: 'setSheetThickness',
          bodyId: b.id,
          // CR5F_THICKNESS: a JSON map of thicknesses (mm) over the table, to see where it gives.
          thicknessMm: {
            ...f29ThicknessMm,
            ...(process.env.CR5F_THICKNESS ? JSON.parse(process.env.CR5F_THICKNESS) : {}),
          }[b.id.replace(/-r$/, '')]!,
        });
    }
    // The mounts are bonded to the sheets they sit on (contacts, CR5f); the sheets to each other
    // by the welds.
    const offered = bondCandidates(
      cad.bodies.map((b) => ({
        bodyId: b.id,
        mesh: meshes.get(b.id)!,
        shell: !mounts.includes(b.id),
      })),
      0.5,
    );
    const mountBonds = offered.candidates.filter(
      (c) => mounts.includes(c.follower.bodyId) || mounts.includes(c.on.bodyId),
    );
    for (const c of mountBonds)
      doc = applySimulationOperation(doc, {
        type: 'addBond',
        bond: candidateBond(doc, c, named, 0.5),
      });
    // CR5f-6: the members' ends on the members they meet, as contacts of their rims (a seam weld,
    // idealised): the pillars on the sills' top walls and the roof rails' bottom walls, the cross
    // members on the sills' inner walls, the rear side members on the rear cross member's back
    // wall. Each takes the follower's end edges (in the plane of the end) and the other body's
    // faces in that plane; only the nodes within the tolerance follow.
    // [follower, on, the axis and place of the follower's edges, of the other's faces (the same
    // plane unless given)].
    const rims: [string, string, 0 | 1 | 2, number, (0 | 1 | 2)?, number?][] = [];
    for (const r of ['', '-r']) {
      const y = r ? 1 : -1;
      for (const p of ['pillar-a', 'pillar-b', 'pillar-c']) {
        rims.push([p + r, 'sill' + r, 2, f29Joints.sillTopZ]);
        rims.push([p + r, 'rail' + r, 2, f29Joints.railBottomZ]);
      }
      for (const c of ['cross-rear', 'cross-middle', 'cross-front'])
        rims.push([c, 'sill' + r, 1, y * f29Joints.sillInnerY]);
      rims.push(['rear-member' + r, 'cross-rear', 0, f29Joints.crossRearBackX]);
      rims.push(['front-extension' + r, 'cross-front', 0, f29Joints.crossFrontFrontX]);
      // CR5f-9: the apron's lower flange's inner edge (y ∓480) on its side member's closure
      // (z 450), and the strut tower's lower edge on that flange.
      rims.push(['apron' + r, 'front-closure' + r, 1, y * 480, 2, 450]);
      rims.push(['tower' + r, 'apron' + r, 2, 450]);
    }
    const rimBonds: { id: string; edges: number; faces: number }[] = [];
    for (const [follower, onBody, axis, at, faceAxis = axis, faceAt = at] of process.env
      .CR5F_NO_RIMS
      ? []
      : rims) {
      const ft = tables.get(follower)!,
        ot = tables.get(onBody)!;
      const edges = ft.edges.flatMap((e, i) => (Math.abs(e.centroid[axis] - at) < 0.5 ? [i] : []));
      const faces = ot.faces.flatMap((f, i) =>
        Math.abs(f.centroid[faceAxis] - faceAt) < 2 ? [i] : [],
      );
      if (!edges.length || !faces.length)
        throw new Error(
          `rim ${follower} → ${onBody}: ${edges.length} edges, ${faces.length} faces`,
        );
      rimBonds.push({ id: `${follower}>${onBody}`, edges: edges.length, faces: faces.length });
      doc = applySimulationOperation(doc, {
        type: 'addBond',
        bond: {
          id: freshSimulationId(doc, 'bond'),
          name: `${named.get(follower)!.name} end on ${named.get(onBody)!.name}`,
          follower: edges.map((i) => ({
            kind: 'edge' as const,
            ref: topologyRefOf(ft, 'edge', i, named.get(follower)!.featureId),
            body: follower,
          })),
          on: faces.map((i) => ({
            kind: 'face' as const,
            ref: topologyRefOf(ot, 'face', i, named.get(onBody)!.featureId),
            body: onBody,
          })),
          tolerance: 1,
          contact: true,
        },
      });
    }
    if (rimBonds.length) console.log(`F29 rim bonds: ${JSON.stringify(rimBonds)}`);
    const placed = new Map((evaluated.evaluation.spotWelds ?? []).map((r) => [r.id, r]));
    for (const w of process.env.CR5E_NO_WELDS ? [] : (cad.spotWelds ?? [])) {
      const r = placed.get(w.id);
      const row: SimulationWeldRow = {
        id: w.id,
        name: w.name,
        flanges: [
          { bodyId: w.flanges[0].bodyId, face: w.flanges[0].face },
          { bodyId: w.flanges[1].bodyId, face: w.flanges[1].face },
        ],
        maxGapMm: w.maxGapMm,
        ...(r?.status === 'ok' ? { points: r.points.length / 3 } : {}),
      };
      doc = applySimulationOperation(doc, {
        type: 'addSpotWeld',
        weld: spotWeldOf(doc, row, named),
      });
    }
    // A torsion test on the mounts' top faces (the counts do not depend on the conditions).
    const top = (bodyId: string) => {
      const t = tables.get(bodyId)!;
      let best = 0;
      t.faces.forEach((f, i) => {
        if (f.centroid[2] > t.faces[best]!.centroid[2]) best = i;
      });
      return [
        {
          kind: 'face' as const,
          ref: topologyRefOf(t, 'face', best, named.get(bodyId)!.featureId),
          body: bodyId,
        },
      ];
    };
    const mountFaces = {
      frontLeft: top('strut-mount'),
      frontRight: top('strut-mount-r'),
      rear: [...top('rear-mount'), ...top('rear-mount-r')],
    };
    // CR5F_TEST: the torsion test (default); `bending`, 1000 N down on the floor pan's largest
    // face; `modal`, the lowest modes with the four mounts held (CR5f).
    const test = process.env.CR5F_TEST ?? 'torsion';
    if (test === 'bending') {
      const t = tables.get('floor')!;
      let largest = 0;
      t.faces.forEach((f, i) => {
        if (f.area > t.faces[largest]!.area) largest = i;
      });
      const loaded = [
        {
          kind: 'face' as const,
          // The floor is the study's source body, named by leaving `body` out.
          ref: topologyRefOf(t, 'face', largest, named.get('floor')!.featureId),
        },
      ];
      for (const op of bendingTestOps(doc, { ...mountFaces, loaded }))
        doc = applySimulationOperation(doc, op);
    } else if (test === 'modal') {
      const held: SimulationConstraint = {
        id: 'modal-mounts',
        name: 'Mounts held',
        kind: 'fixed',
        targets: [...mountFaces.frontLeft, ...mountFaces.frontRight, ...mountFaces.rear],
      };
      doc = applySimulationOperation(doc, { type: 'addConstraint', constraint: held });
      doc = applySimulationOperation(doc, {
        type: 'addStudy',
        study: {
          id: 'modal',
          name: 'Modes, mounts held',
          kind: 'modal',
          loadIds: [],
          constraintIds: [held.id],
          modes: Number(process.env.CR5F_MODES ?? 6),
          solver: { tolerance: 1e-8, maxIterations: 10_000 },
          convergence: { levels: 1, metrics: ['first-frequency'], tolerance: 0.05 },
        } satisfies SimulationStudy,
      });
    } else
      for (const op of torsionTestOps(doc, mountFaces)) doc = applySimulationOperation(doc, op);
    const study = doc.studies.at(-1)!;
    doc = {
      ...doc,
      studies: doc.studies.map((s) =>
        s.id === study.id ? { ...s, convergence: { ...s.convergence, levels: 1 } } : s,
      ),
    };
    const refused = offered.notOffered.filter(
      (n) => mounts.includes(n.bodyId) || mounts.includes(n.onBodyId),
    );
    return { cad, doc, tables, studyId: study.id, mountBonds: mountBonds.length, refused };
  };

  it('counts the nodes the browser meshes and the Host is sent at 20–30 mm', async () => {
    const { cad, doc, tables, studyId, mountBonds, refused } = await setup();
    console.log(`F29 mount bonds offered: ${mountBonds}; refused: ${JSON.stringify(refused)}`);
    // CR5f: each mount sits on part of a sheet (the tower's seat, the rear member's top): contacts.
    expect(mountBonds).toBeGreaterThanOrEqual(4);
    for (const b of doc.bonds ?? []) expect(b.contact).toBe(true);
    expect((doc.bodies ?? []).length + 1).toBe(42);
    if (!process.env.CR5E_NO_WELDS) expect(doc.spotWelds).toHaveLength(68);
    expect(doc.sheets).toHaveLength(38);
    const counts: Count[] = [];
    for (const size of sizes) {
      let run: Awaited<ReturnType<typeof runStudy>> | undefined;
      try {
        run = await runStudy(
          { ...doc, mesh: { ...doc.mesh, size, minSize: Math.min(10, size / 2), grading: 1.5 } },
          cad,
          cadContentHash(cad),
          studyId,
          tables.get('floor')!,
          env(counts, size),
          tables,
        );
      } catch (e) {
        // The counting Host stops the run by throwing once it has counted.
        if (!(e instanceof Counted)) throw e;
      }
      // The run stops where the Host is called: every body meshed, nothing solved.
      if (counts.at(-1)?.size !== size) {
        console.log(`F29 ${size} mm: ${JSON.stringify(run?.failure)}`);
        // Codex on #1010: the one refusal allowed is the rear mount's box at 20 mm (its tets fall
        // under the quality line even with grading 1.3, a CR5f finding); every other size counts.
        expect(size).toBe(20);
        expect(run?.failure?.code).toBe('mesh-quality');
        expect(run?.failure?.detail).toMatch(/^rear-mount(-r)?: /);
      }
    }
    expect(counts.map((c) => c.size)).toEqual(
      sizes.filter((s) => s !== 20 || counts.some((c) => c.size === 20)),
    );
    expect(counts.length).toBeGreaterThan(0);
    console.log(`F29 counts (Host limit ${referenceComputeLimits.nodes} nodes)`);
    for (const c of counts) console.log(JSON.stringify(c));
    // Finer is larger; the Host is sent more nodes than the browser meshes (wedges).
    for (let i = 1; i < counts.length; i++)
      expect(counts[i]!.hostNodes).toBeGreaterThan(counts[i - 1]!.hostNodes);
    for (const c of counts) expect(c.hostNodes).toBeGreaterThan(c.shellNodes + c.solidNodes);
  }, 3_600_000);

  /**
   * CR5f (measurement approved by Ryo, 2026-11-09): F29's torsion solved on CalculiX as the
   * reference Host runs it (`ccx -i job`, OMP_NUM_THREADS 1), its node limit lifted for this run
   * only. CR5F_MEASURE=n runs it n times at CR5E_SIZES' first size; each run's times (the model
   * written, CalculiX, the whole run), CalculiX's peak memory and the stiffness are appended to
   * CR5F_OUT as JSON lines. Not a product path: nothing here changes the Host's limits.
   */
  it.skipIf(!process.env.CR5F_MEASURE)(
    'measures F29 torsion, bending or modes on the reference Host (CR5f)',
    async () => {
      const { cad, doc, tables, studyId } = await setup();
      const size = sizes[0]!;
      const out = process.env.CR5F_OUT ?? path.join(tmpdir(), 'cr5f-measure.jsonl');
      const timeoutMs = Number(process.env.CR5F_TIMEOUT_MS ?? 3_600_000);
      for (let k = 0; k < Number(process.env.CR5F_MEASURE); k++) {
        const record: Record<string, unknown> = { run: k + 1, size, at: new Date().toISOString() };
        const counts: Count[] = [];
        /**
         * Builds the Host's model (`modelMs` counts its construction, the shells' expansion and
         * the bond equations, and its writing, as in CR5f-3), runs CalculiX on it and reads its
         * `.frd` with `read`.
         */
        const onHost = <H extends { model: CalculixModel }, R>(
          build: () => H,
          read: (frd: string, host: H) => R,
        ): R => {
          let t = performance.now();
          const host = build();
          const inp = writeCalculixModel(host.model);
          record.modelMs = performance.now() - t;
          record.inpBytes = Buffer.byteLength(inp);
          // CR5F_STAGE with CR5F_CCX_DIR: run CalculiX apart from this process, whose memory
          // (about 1.7 GB) with CalculiX's (about 12.2 GB at 30 mm) is more than the container
          // has. `write` writes job.inp there and stops; CalculiX is run on it with the same
          // wrapper as below, its line kept in ccx.json; `read` builds the same model again,
          // checks it writes the same job.inp, and reads job.frd and ccx.json.
          const stage = process.env.CR5F_STAGE;
          const kept = process.env.CR5F_CCX_DIR;
          if (stage && !kept) throw new Error('CR5F_STAGE needs CR5F_CCX_DIR');
          const dir = kept ?? mkdtempSync(path.join(tmpdir(), 'cr5f-ccx-'));
          try {
            if (stage === 'write') {
              writeFileSync(path.join(dir, 'job.inp'), inp);
              record.status = 'written';
              throw new Error(`CR5F_STAGE=write: ${path.join(dir, 'job.inp')}`);
            }
            if (stage === 'read') {
              const sha = (s: string) => createHash('sha256').update(s).digest('hex');
              if (sha(readFileSync(path.join(dir, 'job.inp'), 'utf8')) !== sha(inp))
                throw new Error('CR5F_STAGE=read: the model differs from the job.inp written');
              const ccx = JSON.parse(readFileSync(path.join(dir, 'ccx.json'), 'utf8'));
              record.ccx = { ...ccx, tail: undefined };
              record.ccxMs = ccx.wallS * 1000;
              if (ccx.status !== 0) throw new Error(`ccx failed: ${ccx.tail}`);
              t = performance.now();
              const frd = readFileSync(path.join(dir, 'job.frd'), 'utf8');
              record.frdBytes = Buffer.byteLength(frd);
              const result = read(frd, host);
              record.readMs = performance.now() - t;
              return result;
            }
            writeFileSync(path.join(dir, 'job.inp'), inp);
            // CalculiX's wall time and peak resident memory, from a parent that waits for it.
            const wrap = [
              'import json, resource, subprocess, sys, time',
              't = time.monotonic()',
              "p = subprocess.run(['ccx', '-i', 'job'], cwd=sys.argv[1], capture_output=True, text=True, timeout=float(sys.argv[2]))",
              "print(json.dumps({'status': p.returncode, 'wallS': time.monotonic() - t, 'maxRssKiB': resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss, 'tail': (p.stdout + p.stderr)[-2000:]}))",
            ].join('\n');
            t = performance.now();
            const r = spawnSync('python3', ['-I', '-c', wrap, dir, String(timeoutMs / 1000)], {
              encoding: 'utf8',
              env: { PATH: process.env.PATH, OMP_NUM_THREADS: '1' },
              maxBuffer: 1 << 24,
            });
            record.ccxMs = performance.now() - t;
            const ccx = JSON.parse(r.stdout.trim().split('\n').at(-1) || '{}');
            Object.assign(record, {
              ccx: { ...ccx, tail: undefined },
              stderr: r.stderr.slice(-500),
            });
            if (ccx.status !== 0) throw new Error(`ccx failed: ${ccx.tail ?? r.stderr}`);
            t = performance.now();
            const frd = readFileSync(path.join(dir, 'job.frd'), 'utf8');
            record.frdBytes = Buffer.byteLength(frd);
            const result = read(frd, host);
            record.readMs = performance.now() - t;
            return result;
          } finally {
            if (!kept) rmSync(dir, { recursive: true, force: true });
          }
        };
        // The reader's cap (480 MiB since CR5f-8) is lifted for these runs only: F29's static
        // results at 30 mm are about 0.3 GB; its six modes (0.7 GB) are past the longest string,
        // so the modal run is read from CalculiX's job.dat instead (CR5f-9, README).
        const frdLimits = { bytes: 1 << 30 };
        const solveModal = async (input: BondedModalInput): Promise<BondedModalResult> => {
          const result = onHost(
            () => bondedModalHostModel(input),
            (frd, host) =>
              bondedModalResultFromFrd(
                input,
                host,
                readCalculixModes(
                  frd,
                  host.model.nodes.length / 3,
                  calculixModeCount(host.model),
                  frdLimits,
                ),
              ),
          );
          record.frequenciesHz = result.modes.map((m) => m.frequency);
          record.massT = result.mass;
          return result;
        };
        const solve = async (input: BondedInput): Promise<BondedResult> => {
          const result = onHost(
            () => bondedHostModel(input),
            (frd, host) =>
              bondedResultFromFrd(
                input,
                host,
                readCalculixFrd(frd, host.model.nodes.length / 3, 'mm', frdLimits),
              ),
          );
          {
            // CR5F_PARTS=1: where the body gives (each part's largest displacement and summed
            // reaction) and how much each bond ties, to read a stiffness against the structure.
            if (process.env.CR5F_PARTS) {
              record.parts = result.parts.map((r, i) => {
                const per = r.kind === 'shell' ? 6 : 3;
                let max = 0;
                const f = [0, 0, 0];
                for (let n = 0; n < r.displacement.length / per; n++) {
                  const [x, y, z] = [0, 1, 2].map((k) => r.displacement[per * n + k]!);
                  max = Math.max(max, Math.hypot(x!, y!, z!));
                  for (let k = 0; k < 3; k++) f[k]! += r.reaction[per * n + k] ?? 0;
                }
                return { i, body: bodyOrder[i], kind: r.kind, maxMm: max, reactionN: f };
              });
              record.bonds = input.bonds.map((b, i) => ({
                follower: b.follower.part,
                on: b.on.part,
                contact: !!b.contact,
                weldNodes: b.follower.nodes?.length,
                tied: result.bonds[i]?.nodes,
                maxGap: result.bonds[i]?.maxGap,
              }));
              record.reactionMoment = result.reactionMoment;
              // The twist about x along the body: in each 100 mm slice of x, the least-squares
              // rotation θ of the nodes' (y, z) displacement about the slice's centre, per part
              // and for all (rad), to see where the body gives.
              const slices = new Map<number, { all: number[]; parts: Map<string, number[]> }>();
              result.parts.forEach((r, i) => {
                const per = r.kind === 'shell' ? 6 : 3;
                const nodes = input.parts[i]!.mesh.nodes;
                for (let n = 0; n < nodes.length / 3; n++) {
                  const [x, y, z] = [nodes[3 * n]!, nodes[3 * n + 1]!, nodes[3 * n + 2]!];
                  const [v, w] = [r.displacement[per * n + 1]!, r.displacement[per * n + 2]!];
                  const k = Math.floor(x / 100);
                  const s = slices.get(k) ?? { all: [0, 0], parts: new Map() };
                  // θ ≈ Σ (y w − (z − 600) v) / Σ (y² + (z − 600)²), about (y 0, z 600).
                  const zc = z - 600;
                  const add = (acc: number[]) => {
                    acc[0]! += y * w - zc * v;
                    acc[1]! += y * y + zc * zc;
                  };
                  add(s.all);
                  const name = bodyOrder[i] ?? String(i);
                  const own = s.parts.get(name) ?? [0, 0];
                  add(own);
                  s.parts.set(name, own);
                  slices.set(k, s);
                }
              });
              record.twist = [...slices.keys()]
                .sort((a, b) => a - b)
                .map((k) => {
                  const s = slices.get(k)!;
                  return {
                    x: k * 100 + 50,
                    theta: s.all[0]! / s.all[1]!,
                    parts: Object.fromEntries(
                      [...s.parts].map(([name, [a, b]]) => [name, a! / b!]),
                    ),
                  };
                });
            }
          }
          return result;
        };
        const t = performance.now();
        Object.assign(phases, { start: t, surfaceMs: 0, meshMs: 0, spotWeldsMs: 0, toHostMs: 0 });
        bodyOrder.length = 0;
        // Each measured run starts with an empty cache, as a run Worker does.
        features.release();
        features = new FeatureCache();
        let run: Awaited<ReturnType<typeof runStudy>> | undefined;
        try {
          run = await runStudy(
            { ...doc, mesh: { ...doc.mesh, size, minSize: Math.min(10, size / 2), grading: 1.5 } },
            cad,
            cadContentHash(cad),
            studyId,
            tables.get('floor')!,
            env(counts, size, solve, solveModal),
            tables,
          );
        } catch (e) {
          record.error = e instanceof Error ? e.message : String(e);
        }
        Object.assign(record, {
          runMs: performance.now() - t,
          phases: { ...phases, start: undefined },
          count: counts[0],
          failure: run?.failure,
          metrics: run?.levels.at(-1)?.metrics,
          status: run?.status.status,
        });
        console.log(`F29 measure ${JSON.stringify(record)}`);
        appendFileSync(out, `${JSON.stringify(record)}\n`);
      }
    },
    24 * 3_600_000,
  );
});
