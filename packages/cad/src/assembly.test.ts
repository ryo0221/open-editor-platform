import { EditorSession } from '@editor-platform/editor-core';
import { Euler, Quaternion, Raycaster, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  CadAssemblyPort,
  cadContentHash,
  emptyCad,
  expandAssembly,
  fixtureKernel,
  mm,
  r2bParts,
  type CadDocument,
  type CadEvaluateRequest,
  type CadEvaluation,
  type CadPartKernelPort,
  type CadStepPlan,
  type CadComponentPlacement,
} from '@editor-platform/cad-core';
import type { CadMesh } from '@editor-platform/cad-kernel-occt';
import {
  CadAssembly,
  componentStates,
  describeAssemblyCode,
  patternName,
  type CadAssemblyOptions,
  type CadPartSourceHost,
} from './assembly';
import { editedPlacement, mirroredPlacement, placementFields, validPlacement } from './placement';
import { partPath, partsGroup } from './assembly-view';
import { cadInputState } from './binding';
import { CadController, describeCode } from './controller';

const mesh = (bodyId: string, bytes = 12): CadMesh => ({
  bodyId,
  origin: [0, 0, 0],
  positions: new Float32Array(bytes / 4),
  normals: new Float32Array(0),
  indices: new Uint32Array(0),
  faceIds: new Uint32Array(0),
  vertices: new Float64Array(0),
  faceBase: 0,
  edgeBase: 0,
  edges: new Float32Array(0),
  edgeIds: new Uint32Array(0),
  topology: { faces: [], edges: [], vertices: [] },
});

/** A Host with the r2b fixture's versions as saved parts, and an assembly session over a kernel double. */
function setup(
  options: {
    doc?: CadDocument;
    partBytes?: number;
    mainBytes?: number;
    /** Parts whose next job fails for a passing reason (a timeout). */
    failOnce?: Set<string>;
    /** R2b-4: parts no joint reads evaluate after the result. */
    background?: boolean;
    /** R2b-4 (LOD): each part job also gives a coarse mesh of this many bytes per body. */
    coarseBytes?: number;
    /** R2b-5: the kernel's BRep and STEP AP242 writers (doubles). */
    exportBrep?: CadAssemblyOptions['exportBrep'];
    exportAssemblyStep?: CadAssemblyOptions['exportAssemblyStep'];
    /** R2b-5: the kernel's STEP assembly reader (a double); the Host stores assets. */
    importStepAssembly?: CadAssemblyOptions['importStepAssembly'];
    /** Runs while the Host stores staged versions and assets. */
    onStage?: () => Promise<void>;
  } = {},
) {
  const fixture = r2bParts();
  const session = new EditorSession(options.doc ?? emptyCad(fixtureKernel));
  const jobs: string[] = [];
  const answer = (request: CadEvaluateRequest): CadEvaluation => ({
    status: 'ok',
    contentHash: request.candidateHash,
    buildHash: request.document.kernelProfile.buildHash,
    geometryDigest: 'd',
    bodies: Object.fromEntries(
      request.document.bodies
        .filter((b) => b.state === 'active')
        .map((b) => [
          b.id,
          {
            kind: 'solid' as const,
            volumeMm3: 1,
            areaMm2: 1,
            bounds: [
              [0, 0, 0],
              [80, 50, 5],
            ] as [[number, number, number], [number, number, number]],
          },
        ]),
    ),
  });
  // As the binding routes the Worker port's meshes: a part job's go to the parts.
  const deliver = (request: CadEvaluateRequest) => {
    const active = request.document.bodies.filter((b) => b.state === 'active');
    const meshes = [
      ...active.map((b) => mesh(b.id, options.partBytes)),
      ...(request.coarse
        ? active.map((b) => ({ ...mesh(b.id, options.coarseBytes), lod: 'coarse' as const }))
        : []),
    ];
    if (port.partJobs.has(request.candidateHash)) assembly.receive(request.candidateHash, meshes);
    else controller.receiveMeshes(request.candidateHash, meshes);
  };
  const kernel: CadPartKernelPort = {
    evaluate: async (request) => {
      jobs.push(`own:${request.candidateHash.slice(0, 6)}`);
      deliver(request);
      return answer(request);
    },
    evaluatePart: async (request, assembly) => {
      jobs.push(`part:${request.candidateHash.slice(0, 6)}`);
      if (options.failOnce?.delete(request.candidateHash))
        return {
          status: 'error',
          contentHash: request.candidateHash,
          code: 'kernel-timeout',
          retryable: true,
        };
      if (request.document.kernelProfile.buildHash !== assembly.buildHash)
        return {
          status: 'error',
          contentHash: request.candidateHash,
          code: 'part-build-mismatch',
          retryable: false,
        };
      deliver(request);
      return answer(request);
    },
    cancel: () => {},
  };
  const kept = new Map<string, CadDocument>();
  const staged: string[] = [];
  /** Each stage call: versions and asset count, in order. */
  const stages: [number, number][] = [];
  const store = {
    get: (hash: string) => kept.get(hash),
    stage: async (versions: CadDocument[], assets: unknown[]) => {
      stages.push([versions.length, assets.length]);
      await options.onStage?.();
      for (const v of versions) {
        kept.set(cadContentHash(v), v);
        staged.push(cadContentHash(v));
      }
    },
  };
  const versions = [fixture.plate, fixture.shaft, fixture.pair];
  const other = structuredClone(fixture.plate.content);
  other.kernelProfile.buildHash = `sha256:${'b'.repeat(64)}`;
  const otherV = {
    artifactId: 'old',
    versionId: 'v1',
    contentHash: cadContentHash(other),
    content: other,
  };
  const access = new Set(['plate', 'shaft', 'pair', 'old']);
  const watchers = new Set<() => void>();
  const notify = () => watchers.forEach((w) => w());
  const source: CadPartSourceHost = {
    subscribe: (w) => (watchers.add(w), () => void watchers.delete(w)),
    list: async () =>
      [...versions, otherV].map((v) => ({
        artifactId: v.artifactId,
        name: v.artifactId,
        versions: [{ versionId: v.versionId, label: 'v1', contentHash: v.contentHash }],
      })),
    readVersion: async (artifactId) => {
      const v = [...versions, otherV].find((x) => x.artifactId === artifactId)!;
      const closure = artifactId === 'pair' ? [fixture.plate.content] : [];
      // The shaft brings an asset (as an imported body's BRep would).
      const assets =
        artifactId === 'shaft' ? [{ ref: { id: 'brep' } as never, bytes: new Uint8Array(1) }] : [];
      return { content: v.content, contentHash: v.contentHash, closure, assets };
    },
    checkAccess: (id) => access.has(id),
  };
  const port = new CadAssemblyPort({
    kernel,
    parts: (h) => store.get(h),
    access: (id) => access.has(id),
    ...(options.background ? { background: true } : {}),
    ...(options.coarseBytes ? { coarse: true } : {}),
  });
  const controller = new CadController({
    session,
    kernel: port,
    canEdit: () => true,
    permissionGeneration: () => 0,
    ...(options.importStepAssembly
      ? {
          assets: { get: () => undefined, stage: async () => {} },
          importStep: async () => ({ status: 'rejected' as const, code: 'step-assembly' as const }),
        }
      : {}),
  });
  const assembly = new CadAssembly({
    controller,
    port,
    store,
    source,
    ...(options.mainBytes ? { mainBytes: options.mainBytes } : {}),
    ...(options.exportBrep ? { exportBrep: options.exportBrep } : {}),
    ...(options.exportAssemblyStep ? { exportAssemblyStep: options.exportAssemblyStep } : {}),
    ...(options.importStepAssembly ? { importStepAssembly: options.importStepAssembly } : {}),
  });
  return {
    fixture,
    session,
    controller,
    assembly,
    port,
    jobs,
    staged,
    stages,
    kept,
    access,
    notify,
  };
}

describe('assembly in the Surface (R2b-1, CAD49/CAD51/CAD53/CAD54)', () => {
  it('inserts saved versions at the origin, sharing one definition and one evaluation', async () => {
    const { controller, assembly, port, fixture, staged } = setup();
    await controller.refresh();
    expect(await assembly.insert('plate', 'v1', 'Plate')).toBe(true);
    expect(await assembly.insert('plate', 'v1', 'Plate')).toBe(true);
    expect(await assembly.insert('pair', 'v1', 'Pair')).toBe(true);
    const doc = controller.getSnapshot().content;
    expect(doc.parts.map((p) => p.name)).toEqual(['Plate', 'Pair']);
    expect(doc.components.map((c) => c.name)).toEqual(['Plate 1', 'Plate 2', 'Pair 1']);
    expect(doc.parts[0]!.hint.boundsMm).toEqual([
      [0, 0, 0],
      [80, 50, 5],
    ]);
    // The pair's bounds come from its two plates' hints at their saved poses (one 20 mm up).
    expect(doc.parts[1]!.hint.boundsMm).toEqual([
      [0, 0, 0],
      [100, 50, 25],
    ]);
    // The closure was stored before the edits named it: the plate once, the pair with its plate.
    expect(new Set(staged)).toEqual(new Set([fixture.plate.contentHash, fixture.pair.contentHash]));
    expect(port.partEvaluations).toBe(2);
    expect(assembly.meshes(fixture.plate.contentHash)).toHaveLength(1);
    expect(assembly.getSnapshot().selected).toBe(doc.components[2]!.id);
    const states = componentStates(doc, controller.getSnapshot().evaluation, assembly.lookup);
    expect([...states.values()].map((s) => s.state)).toEqual([
      'available',
      'available',
      'available',
    ]);
  });

  it("names a version by the Host's label, else by the start of its ID (ST-85#2)", () => {
    const { assembly } = setup();
    expect(assembly.versionLabel('plate', 'v1')).toBe('version v1');
    expect(assembly.versionLabel('plate', '0123456789abcdef0123')).toBe(
      'version 0123456789abcdef…',
    );
  });

  it('moves and removes a component in one edit each, and Undo returns without a part job', async () => {
    const { controller, assembly, port, session } = setup();
    await controller.refresh();
    await assembly.insert('shaft', 'v1', 'Shaft');
    const id = controller.getSnapshot().content.components[0]!.id;
    expect(await assembly.place(id, [10, 20, 30], [0, 0, Math.SQRT1_2, Math.SQRT1_2])).toBe(true);
    expect(controller.getSnapshot().content.solvedPoses[id]!.translationMm).toEqual([10, 20, 30]);
    const jobs = port.partEvaluations;
    session.undo();
    await controller.sync();
    expect(controller.getSnapshot().content.solvedPoses[id]!.translationMm).toEqual([0, 0, 0]);
    expect(port.partEvaluations).toBe(jobs);
    expect(await assembly.remove(id)).toBe(true);
    expect(controller.getSnapshot().content.parts).toEqual([]);
  });

  it('keeps a placement entry across selection and other edits until it is applied or overtaken', async () => {
    const { controller, assembly, session } = setup();
    await controller.refresh();
    await assembly.insert('plate', 'v1', 'Plate');
    await assembly.insert('shaft', 'v1', 'Shaft');
    const [a, b] = controller.getSnapshot().content.components.map((c) => c.id) as [string, string];
    const shown = placementFields(controller.getSnapshot().content.solvedPoses[a]!);
    assembly.setDraft(a, { fields: ['5', ...shown.slice(1)], shown });
    // Selecting another component or a body, and an edit of another component, keep it.
    assembly.select(b);
    controller.select(null);
    expect(await assembly.place(b, [1, 0, 0], [0, 0, 0, 1])).toBe(true);
    expect(assembly.getSnapshot().drafts.get(a)?.fields[0]).toBe('5');
    // Applying it is one edit and drops it.
    expect(await assembly.applyDraft(a)).toBe(true);
    expect(assembly.getSnapshot().drafts.size).toBe(0);
    expect(controller.getSnapshot().content.solvedPoses[a]!.translationMm).toEqual([5, 0, 0]);
    // A refused entry is not kept.
    const now = placementFields(controller.getSnapshot().content.solvedPoses[a]!);
    assembly.setDraft(a, { fields: ['1000001', ...now.slice(1)], shown: now });
    expect(await assembly.applyDraft(a)).toBe(false);
    expect(assembly.getSnapshot().drafts.size).toBe(0);
    // Undo changes the stored placement under an entry: the entry goes with it.
    assembly.setDraft(a, { fields: ['7', ...now.slice(1)], shown: now });
    session.undo();
    await controller.sync();
    expect(assembly.getSnapshot().drafts.size).toBe(0);
    // An entry equal to what is shown is no entry.
    assembly.setDraft(b, { fields: shown, shown });
    expect(assembly.getSnapshot().drafts.size).toBe(0);
  });

  it('refuses another build, a revoked part, a tampered read and exports, naming the reason', async () => {
    const { controller, assembly, access } = setup();
    await controller.refresh();
    expect(await assembly.insert('old', 'v1', 'Old')).toBe(false);
    expect(controller.getSnapshot().diagnostic?.message).toBe(
      describeAssemblyCode('part-build-mismatch'),
    );
    access.delete('shaft');
    expect(await assembly.insert('shaft', 'v1', 'Shaft')).toBe(false);
    expect(controller.getSnapshot().diagnostic?.message).toContain('権限');
    expect(controller.getSnapshot().content.components).toEqual([]);
    await assembly.insert('plate', 'v1', 'Plate');
    expect(await controller.exportStep()).toBeUndefined();
    expect(controller.getSnapshot().diagnostic?.message).toBe(
      describeCode('assembly-export-unsupported'),
    );
    expect(await controller.exportMesh('stl')).toBeUndefined();
  });

  it('shows a part without its closure entry or access as unavailable, never another version', async () => {
    const { fixture } = setup();
    const { controller, kept, access } = setup({ doc: fixture.assembly });
    for (const [h, d] of fixture.closure) if (h !== fixture.shaft.contentHash) kept.set(h, d);
    access.delete('plate');
    await controller.refresh();
    const states = componentStates(fixture.assembly, controller.getSnapshot().evaluation, (h) =>
      kept.get(h),
    );
    expect(Object.fromEntries(states)).toEqual({
      'c-plate-1': { state: 'unavailable', code: 'part-access-revoked' },
      'c-plate-2': { state: 'unavailable', code: 'part-access-revoked' },
      'c-shaft': { state: 'unavailable', code: 'part-source-missing' },
      // The pair's plates are revoked too: the worst state inside it.
      'c-pair': { state: 'unavailable', code: 'part-access-revoked' },
    });
    expect(describeCode('part-source-missing')).toContain('箱');
  });

  it('keeps part meshes within the main-thread budget and draws the rest as boxes', async () => {
    const { controller, assembly, fixture } = setup({
      partBytes: 4096,
      mainBytes: 6000,
    });
    await controller.refresh();
    await assembly.insert('plate', 'v1', 'Plate');
    await assembly.insert('shaft', 'v1', 'Shaft');
    expect(assembly.meshes(fixture.plate.contentHash)).toBeDefined();
    expect(assembly.getSnapshot().simplified.has(fixture.shaft.contentHash)).toBe(true);
  });

  it("shrinks part meshes when the editor's own meshes grow into the shared budget", async () => {
    const { controller, assembly, fixture } = setup({ partBytes: 4096, mainBytes: 10_000 });
    await controller.refresh();
    await assembly.insert('plate', 'v1', 'Plate');
    expect(assembly.meshes(fixture.plate.contentHash)).toBeDefined();
    await controller.addPrimitive('box');
    expect(assembly.meshes(fixture.plate.contentHash)).toBeDefined();
    // Two bodies of 4,096 bytes and the plate's 4,096 no longer fit 10,000: the plate is a box.
    await controller.addPrimitive('box');
    expect(controller.retainedMeshBytes).toBeGreaterThan(10_000 - 4096);
    expect(assembly.meshes(fixture.plate.contentHash)).toBeUndefined();
    expect(assembly.getSnapshot().simplified.has(fixture.plate.contentHash)).toBe(true);
  });

  it('keeps the coarse meshes of a part the budget cannot keep whole (R2b-4, LOD)', async () => {
    const { controller, assembly, fixture } = setup({
      partBytes: 4096,
      coarseBytes: 512,
      mainBytes: 6000,
    });
    await controller.refresh();
    await assembly.insert('plate', 'v1', 'Plate');
    expect(assembly.meshes(fixture.plate.contentHash)?.every((m) => !m.lod)).toBe(true);
    expect(assembly.coarseMeshes(fixture.plate.contentHash)?.map((m) => m.lod)).toEqual(['coarse']);
    // 4,608 held; the shaft's 4,608 does not fit 6,000, its 512 coarse bytes do.
    await assembly.insert('shaft', 'v1', 'Shaft');
    const shaft = fixture.shaft.contentHash;
    expect(assembly.meshes(shaft)).toBeUndefined();
    expect(assembly.coarseMeshes(shaft)).toHaveLength(1);
    expect(assembly.getSnapshot().simplified.has(shaft)).toBe(true);
    // The LOD is display only: the parts' results are the same as without coarse meshes.
    const plain = setup({ partBytes: 4096, mainBytes: 6000 });
    await plain.controller.refresh();
    await plain.assembly.insert('plate', 'v1', 'Plate');
    await plain.assembly.insert('shaft', 'v1', 'Shaft');
    const versions = (c: CadController) => {
      const e = c.getSnapshot().evaluation;
      return e?.status === 'ok' ? e.assembly?.versions : undefined;
    };
    expect(versions(controller)).toBeDefined();
    expect(versions(plain.controller)).toEqual(versions(controller));
  });

  it('drops the standard meshes of the parts smallest on screen first, then their coarse ones', async () => {
    const { fixture } = setup();
    const { controller, assembly, kept } = setup({
      doc: fixture.assembly,
      partBytes: 2048,
      coarseBytes: 256,
      mainBytes: 6500,
    });
    const [plate, shaft] = [fixture.plate.contentHash, fixture.shaft.contentHash];
    // The shaft (its box from x = 30) is small on screen, the plates large.
    assembly.setScreenSize(([lo]) => (Math.abs(lo[0] - 30) < 1e-6 ? 10 : 500));
    for (const [h, d] of fixture.closure) kept.set(h, d);
    await controller.refresh();
    expect(assembly.meshes(plate) && assembly.meshes(shaft)).toBeDefined();
    const left = () => 6500 - controller.retainedMeshBytes;
    // 2 × (2,048 + 256) held: the editor's first own body leaves less, and the shaft goes coarse.
    await controller.addPrimitive('box');
    expect(left()).toBeLessThan(4608);
    expect(left()).toBeGreaterThanOrEqual(2560);
    expect(assembly.meshes(shaft)).toBeUndefined();
    expect(assembly.coarseMeshes(shaft)).toHaveLength(1);
    expect(assembly.meshes(plate)).toBeDefined();
    // With room for one coarse part only, the plate goes coarse too and the smaller shaft loses
    // its coarse meshes first: it is a box.
    await controller.addPrimitive('box');
    expect(left()).toBeLessThan(512);
    expect(left()).toBeGreaterThanOrEqual(256);
    expect(assembly.meshes(plate)).toBeUndefined();
    expect(assembly.coarseMeshes(plate)).toHaveLength(1);
    expect(assembly.coarseMeshes(shaft)).toBeUndefined();
    expect([...assembly.getSnapshot().simplified].sort()).toEqual([plate, shaft].sort());
  });

  it('hides a part whose access the Host revokes, and drops part meshes of another build', async () => {
    const { controller, assembly, fixture, access, notify, port } = setup();
    await controller.refresh();
    await assembly.insert('plate', 'v1', 'Plate');
    await assembly.insert('shaft', 'v1', 'Shaft');
    access.delete('shaft');
    // Shown as revoked at once, from the Host's current answer, before any evaluation.
    const now = componentStates(
      controller.getSnapshot().content,
      controller.getSnapshot().evaluation,
      assembly.lookup,
      assembly.access,
    );
    expect([...now.values()].map((s) => s.code)).toEqual([undefined, 'part-access-revoked']);
    notify();
    await controller.sync();
    expect(assembly.meshes(fixture.shaft.contentHash)).toBeUndefined();
    const evaluation = controller.getSnapshot().evaluation;
    expect(evaluation?.status === 'ok' && evaluation.assembly!.versions).toMatchObject({
      [fixture.shaft.contentHash]: { state: 'unavailable', code: 'part-access-revoked' },
    });
    // A migrated assembly: the plate's meshes were made with the earlier build.
    expect(
      await controller.run({
        type: 'setKernelBuild',
        kernelId: 'other',
        buildHash: `sha256:${'c'.repeat(64)}`,
      }),
    ).toBe(true);
    expect(assembly.meshes(fixture.plate.contentHash)).toBeUndefined();
    expect(port.has(fixture.plate.contentHash)).toBe(true);
  });

  it('keeps placement values the user did not change at their stored precision', () => {
    const pose = {
      translationMm: [1.234567, 2.5, 0] as [number, number, number],
      rotation: [0, 0, Math.sin(0.1234567), Math.cos(0.1234567)] as [
        number,
        number,
        number,
        number,
      ],
    };
    const shown = placementFields(pose);
    expect(shown[0]).toBe('1.235');
    const fields = [...shown];
    fields[1] = '7';
    const doc = setup().controller.getSnapshot().content;
    const [t, r] = editedPlacement(pose, shown, fields, doc);
    expect(t).toEqual([mm(1.234567), mm(7), mm(0)]);
    expect(r).toBe(pose.rotation);
    fields[3] = '10';
    const [, turned] = editedPlacement(pose, shown, fields, doc);
    // Z keeps its exact angle; only X is the typed value.
    const e = new Euler().setFromQuaternion(new Quaternion(...turned), 'XYZ');
    expect(e.x).toBeCloseTo(Math.PI / 18, 12);
    expect(e.y).toBeCloseTo(0, 12);
    expect(e.z).toBeCloseTo(0.2469134, 12);
  });

  it("stores a part's assets before its first evaluation, and its versions before the edit", async () => {
    const { controller, assembly, stages, jobs } = setup();
    await controller.refresh();
    expect(await assembly.insert('shaft', 'v1', 'Shaft')).toBe(true);
    expect(stages).toEqual([
      [0, 1],
      [1, 0],
    ]);
    expect(jobs.filter((j) => j.startsWith('part:'))).toHaveLength(1);
  });

  it('shows a part again when the Host restores access', async () => {
    const { controller, assembly, fixture, access, notify } = setup();
    await controller.refresh();
    await assembly.insert('shaft', 'v1', 'Shaft');
    access.delete('shaft');
    notify();
    await controller.sync();
    const state = () => {
      const e = controller.getSnapshot().evaluation;
      return e?.status === 'ok' ? e.assembly!.versions[fixture.shaft.contentHash] : undefined;
    };
    expect(state()?.code).toBe('part-access-revoked');
    access.add('shaft');
    notify();
    await controller.sync();
    expect(state()?.state).toBe('available');
    expect(assembly.meshes(fixture.shaft.contentHash)).toBeDefined();
  });

  it('evaluates again a revoked result that history returns to after access is restored', async () => {
    const { controller, assembly, fixture, access, notify, session } = setup();
    await controller.refresh();
    await assembly.insert('shaft', 'v1', 'Shaft');
    const id = controller.getSnapshot().content.components[0]!.id;
    const state = () => {
      const e = controller.getSnapshot().evaluation;
      return e?.status === 'ok' ? e.assembly!.versions[fixture.shaft.contentHash] : undefined;
    };
    access.delete('shaft');
    notify();
    await controller.sync();
    expect(state()?.code).toBe('part-access-revoked');
    // Another content while revoked, then access returns there, then Undo to the first.
    expect(await assembly.place(id, [5, 0, 0], [0, 0, 0, 1])).toBe(true);
    access.add('shaft');
    notify();
    await controller.sync();
    expect(state()?.state).toBe('available');
    session.undo();
    await controller.sync();
    await controller.sync();
    expect(state()?.state).toBe('available');
  });

  it('recovers an evicted part each time history returns to it', async () => {
    const { controller, assembly, session, fixture } = setup({ partBytes: 4096, mainBytes: 6000 });
    const settled = async () => {
      for (let i = 0; i < 6; i++) {
        await controller.sync();
        await new Promise((r) => setTimeout(r));
      }
    };
    await controller.refresh();
    await assembly.insert('plate', 'v1', 'Plate');
    await assembly.remove(controller.getSnapshot().content.components[0]!.id);
    await assembly.insert('shaft', 'v1', 'Shaft');
    // One part fits the budget: the shaft's arrival released the plate.
    expect(assembly.meshes(fixture.plate.contentHash)).toBeUndefined();
    for (let round = 0; round < 2; round++) {
      session.undo();
      session.undo();
      await settled();
      expect(assembly.meshes(fixture.plate.contentHash), `round ${round}`).toBeDefined();
      session.redo();
      session.redo();
      await settled();
      expect(assembly.meshes(fixture.shaft.contentHash), `round ${round}`).toBeDefined();
    }
  });

  it('tries a part that failed for a passing reason again on request', async () => {
    const failOnce = new Set<string>();
    const { controller, assembly, port, fixture } = setup({ failOnce });
    await controller.refresh();
    await assembly.insert('plate', 'v1', 'Plate');
    expect(assembly.retryParts()).toBe(false);
    // The plate's next job times out while the assembly evaluates.
    port.forget(fixture.plate.contentHash);
    failOnce.add(fixture.plate.contentHash);
    controller.coordinator.forget(controller.getSnapshot().contentHash);
    await controller.refresh();
    const version = () => {
      const e = controller.getSnapshot().evaluation;
      return e?.status === 'ok' ? e.assembly!.versions[fixture.plate.contentHash] : undefined;
    };
    expect(version()).toEqual({ state: 'failed', code: 'kernel-timeout', retryable: true });
    const before = port.partEvaluations;
    expect(assembly.retryParts()).toBe(true);
    await controller.sync();
    expect(version()?.state).toBe('available');
    expect(port.partEvaluations - before).toBe(1);
  });

  it("holds the Host's input boundary while an insert is under way", async () => {
    const { controller, assembly } = setup();
    await controller.refresh();
    const inserting = assembly.insert('plate', 'v1', 'Plate');
    expect(cadInputState(controller, assembly)).toEqual({ dirty: true, settles: false });
    await inserting;
    expect(cadInputState(controller, assembly).dirty).toBe(false);
  });

  it('shows the parts inside a revoked sub-assembly as unavailable with it', async () => {
    const { fixture } = setup();
    const { controller, kept, access, assembly } = setup({ doc: fixture.assembly });
    for (const [h, d] of fixture.closure) kept.set(h, d);
    access.delete('pair');
    await controller.refresh();
    const states = componentStates(
      fixture.assembly,
      controller.getSnapshot().evaluation,
      assembly.lookup,
      assembly.access,
    );
    expect(states.get('c-pair')).toEqual({ state: 'unavailable', code: 'part-access-revoked' });
    expect(states.get('c-plate-1')?.state).toBe('available');
  });
  it('places nothing from retained content that does not match its hash', async () => {
    const { fixture } = setup();
    const { controller, kept, assembly } = setup({ doc: fixture.assembly });
    for (const [h, d] of fixture.closure) kept.set(h, d);
    // The pair's content moved its second plate: same name, other bytes.
    const tampered = structuredClone(fixture.pair.content);
    tampered.solvedPoses['pair-b']!.translationMm = [500, 0, 0];
    kept.set(fixture.pair.contentHash, tampered);
    await controller.refresh();
    expect(assembly.lookup(fixture.pair.contentHash)).toBeUndefined();
    const { occurrences } = expandAssembly(fixture.assembly, assembly.lookup);
    // The pair is one box; the plate placed directly is still drawn, nothing inside the pair is.
    expect(occurrences.filter((o) => o.path[0] === 'c-pair').map((o) => o.path)).toEqual([
      ['c-pair'],
    ]);
    const states = componentStates(
      fixture.assembly,
      controller.getSnapshot().evaluation,
      assembly.lookup,
      assembly.access,
    );
    expect(states.get('c-pair')).toEqual({ state: 'unavailable', code: 'part-source-mismatch' });
    expect(states.get('c-plate-1')?.state).toBe('available');
  });
  it("picks a component from its part's outline as from its surface", () => {
    const group = partsGroup([
      {
        bounds: [
          [0, 0, 0],
          [10, 10, 10],
        ],
        box: 'pending',
        instances: [
          {
            path: ['a'],
            matrix: new Array(16).fill(0).map((_, i) => (i % 5 ? 0 : 1)),
            selected: false,
          },
          {
            path: ['b', 'inner'],
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1],
            selected: false,
          },
        ],
      },
    ]);
    group.updateMatrixWorld(true);
    const first = (origin: Vector3) =>
      new Raycaster(origin, new Vector3(0, 1, 0)).intersectObjects(group.children, false)[0];
    // Through a face, and 0.5 mm past an edge: only the outline is hit there.
    expect(partPath(first(new Vector3(105, -50, 5)))).toEqual(['b', 'inner']);
    const edge = first(new Vector3(10.5, -50, 5));
    expect(edge?.object.type).toBe('LineSegments');
    expect(partPath(edge)).toEqual(['a']);
  });
});

describe('placing inserted parts (ST-86)', () => {
  it('inserts beside what is shown, at the origin or at typed values', async () => {
    const { controller, assembly } = setup();
    await controller.refresh();
    const at = () => controller.getSnapshot().content.solvedPoses;
    const last = () => controller.getSnapshot().content.components.at(-1)!.id;
    // An empty document: the origin. Then past the plate's +X side, by half its width (80 mm).
    expect(await assembly.insert('plate', 'v1', 'Plate')).toBe(true);
    expect(at()[last()]!.translationMm).toEqual([0, 0, 0]);
    expect(await assembly.insert('plate', 'v1', 'Plate')).toBe(true);
    expect(at()[last()]!.translationMm).toEqual([120, 0, 0]);
    expect(await assembly.insert('plate', 'v1', 'Plate', 'origin')).toBe(true);
    expect(at()[last()]!.translationMm).toEqual([0, 0, 0]);
    const turned: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    expect(
      await assembly.insert('plate', 'v1', 'Plate', {
        translation: [mm(10), mm(-20), mm(30)],
        rotation: turned,
      }),
    ).toBe(true);
    expect(at()[last()]).toEqual({ translationMm: [10, -20, 30], rotation: turned });
  });

  it('inserts beside pattern copies too', async () => {
    const { controller, assembly } = setup();
    await controller.refresh();
    await assembly.insert('plate', 'v1', 'Plate');
    const seed = controller.getSnapshot().content.components[0]!.id;
    // Three copies 200 mm apart: the last ends at 400 + 40 mm.
    expect(
      await assembly.insertPattern(seed, {
        type: 'linear',
        direction: [1, 0, 0],
        count: { literal: 3 },
        spacing: mm(200),
      }),
    ).toBe(true);
    await assembly.insert('plate', 'v1', 'Plate');
    const doc = controller.getSnapshot().content;
    expect(doc.solvedPoses[doc.components.at(-1)!.id]!.translationMm).toEqual([520, 0, 0]);
  });

  it('takes a length expression in a placement field, and it follows the parameter', async () => {
    const { controller, assembly } = setup();
    await controller.refresh();
    await controller.addParameter('length');
    const w = controller.getSnapshot().content.parameters.at(-1)!.id;
    await controller.run({ type: 'rename', targetId: w, name: 'Axle' });
    await controller.run({ type: 'setParameter', parameterId: w, value: 3550 });
    await assembly.insert('plate', 'v1', 'Plate');
    const id = controller.getSnapshot().content.components.at(-1)!.id;
    const doc = () => controller.getSnapshot().content;
    const component = () => doc().components.find((c) => c.id === id)!;
    const shown = placementFields(doc().solvedPoses[id]!, component().placement, doc());
    // A name that is not a parameter, or an angle, does not read as a position.
    expect(validPlacement(['Nope', ...shown.slice(1)], shown, doc())).toBe(false);
    expect(validPlacement(['10 deg', ...shown.slice(1)], shown, doc())).toBe(false);
    expect(validPlacement(['Axle - 250mm', ...shown.slice(1)], shown, doc())).toBe(true);
    assembly.setDraft(id, { fields: ['Axle - 250mm', ...shown.slice(1)], shown });
    expect(await assembly.applyDraft(id)).toBe(true);
    expect(doc().solvedPoses[id]!.translationMm).toEqual([3300, 0, 0]);
    // The field shows the expression, and the position follows the parameter.
    const bound = placementFields(doc().solvedPoses[id]!, component().placement, doc());
    expect(bound[0]).toBe('Axle - 250mm');
    // A name that needs braces keeps them, so the field reads back as the same parameter.
    await controller.run({ type: 'rename', targetId: w, name: 'Axle-front' });
    expect(placementFields(doc().solvedPoses[id]!, component().placement, doc())[0]).toBe(
      '{Axle-front} - 250mm',
    );
    const affine = {
      translation: [{ affine: { parameterId: w, scale: 2, offsetMm: -5 } }, mm(0), mm(0)],
      rotation: [0, 0, 0, 1],
    } as CadComponentPlacement;
    const text = placementFields(doc().solvedPoses[id]!, affine, doc())[0]!;
    expect(text).toBe('{Axle-front} * 2 - 5mm');
    expect(validPlacement([text, ...shown.slice(1)], shown, doc())).toBe(true);
    await controller.run({ type: 'rename', targetId: w, name: 'Axle' });
    await controller.run({ type: 'setParameter', parameterId: w, value: 3000 });
    expect(doc().solvedPoses[id]!.translationMm).toEqual([2750, 0, 0]);
    // Another field changed keeps the bound position.
    assembly.setDraft(id, { fields: [...bound.slice(0, 2), '5', ...bound.slice(3)], shown: bound });
    expect(await assembly.applyDraft(id)).toBe(true);
    expect(component().placement!.translation[0]).toHaveProperty('expression');
    expect(doc().solvedPoses[id]!.translationMm).toEqual([2750, 0, 5]);
  });

  it('copies a component across a plane, turned half a turn, in one edit', async () => {
    const { controller, assembly, session } = setup();
    await controller.refresh();
    await assembly.insert('plate', 'v1', 'Plate', {
      translation: [mm(1200), mm(800), mm(300)],
      rotation: [0, 0, 0, 1],
    });
    const seed = controller.getSnapshot().content.components[0]!.id;
    expect(await assembly.duplicateMirrored(seed, 'xz')).toBe(true);
    const doc = controller.getSnapshot().content;
    const copy = doc.components[1]!;
    expect(copy.name).toBe('Plate 2');
    expect(copy.partId).toBe(doc.components[0]!.partId);
    expect(doc.solvedPoses[copy.id]!.translationMm).toEqual([1200, -800, 300]);
    const r = doc.solvedPoses[copy.id]!.rotation;
    expect(r.map((v) => Math.abs(v))).toEqual([0, 0, 1, 0]);
    expect(assembly.getSnapshot().selected).toBe(copy.id);
    session.undo();
    await controller.sync();
    expect(controller.getSnapshot().content.components).toHaveLength(1);
    // A bound position is negated, so the copy keeps following the parameter.
    const across = mirroredPlacement(
      { translation: [mm(0), { parameterId: 'p' }, mm(0)], rotation: [0, 0, 0, 1] },
      'xz',
    );
    expect(across.translation[1]).toEqual({
      expression: { postfix: [{ parameterId: 'p' }, { operator: 'neg' }] },
    });
    expect(
      mirroredPlacement({ translation: [mm(0), mm(0), mm(5)], rotation: [0, 0, 0, 1] }, 'xy'),
    ).toEqual({ translation: [mm(0), mm(0), mm(-5)], rotation: [1, 0, 0, 0] });
  });
});

describe('component patterns in the Surface (R2b-3)', () => {
  it('names a new pattern after its seed within the name limit', () => {
    expect(patternName('Bolt')).toBe('Bolt pattern');
    const long = patternName('😀'.repeat(256));
    expect([...long]).toHaveLength(256);
    expect(long.endsWith(' pattern')).toBe(true);
  });
});

describe('parts evaluated after the result in the Surface (R2b-4, CAD50)', () => {
  it('lists parts as pending, then available as each arrives, largest on screen first', async () => {
    const { fixture } = setup();
    const { controller, assembly, port, kept, jobs } = setup({
      doc: fixture.assembly,
      background: true,
    });
    for (const [h, d] of fixture.closure) kept.set(h, d);
    // The shaft shows largest, the pair's plates smallest.
    const size = (b: [number[], number[]]) =>
      b[1][2]! - b[0][2]! > 30 ? 100 : b[1][2]! > 20 ? 1 : 10;
    assembly.setScreenSize(size as never);
    await controller.refresh();
    const { evaluation } = controller.getSnapshot();
    expect(evaluation?.status === 'ok' && evaluation.assembly?.pending).toHaveLength(3);
    const states = () =>
      Object.fromEntries(
        [
          ...componentStates(
            fixture.assembly,
            evaluation,
            assembly.lookup,
            assembly.access,
            assembly.later,
          ),
        ].map(([id, s]) => [id, s.state]),
      );
    expect(assembly.getSnapshot().progress).toMatchObject({ total: 3 });
    await port.idle();
    expect(jobs.filter((j) => j.startsWith('part:'))).toEqual(
      [fixture.shaft, fixture.plate, fixture.pair].map((v) => `part:${v.contentHash.slice(0, 6)}`),
    );
    expect(states()).toEqual({
      'c-plate-1': 'available',
      'c-plate-2': 'available',
      'c-shaft': 'available',
      'c-pair': 'available',
    });
    expect(assembly.getSnapshot().progress).toBeUndefined();
    expect(assembly.meshes(fixture.shaft.contentHash)).toBeDefined();
  });
});

describe('STEP AP242 export of an assembly (R2b-5, CAD52)', () => {
  it('writes each shaped version once, then the products and instances, after every part arrives', async () => {
    const { fixture } = setup();
    const breps: string[] = [];
    const written: { plan: CadStepPlan; breps: string[] }[] = [];
    const { controller, assembly, port, kept, access } = setup({
      doc: fixture.assembly,
      background: true,
      exportBrep: async (request) => {
        breps.push(request.candidateHash);
        return {
          evaluation: {
            status: 'ok',
            contentHash: request.candidateHash,
            buildHash: request.document.kernelProfile.buildHash,
            geometryDigest: 'd',
            bodies: {},
          },
          brep: {
            bytes: new Uint8Array([1]),
            bounds: [
              [0, 0, 0],
              [1, 1, 1],
            ],
            kinds: ['solid'],
            appearances: [{ color: '#9aa4b1', opacity: 1 }],
            faces: [6],
          },
        };
      },
      exportAssemblyStep: async (_profile, _id, plan, bytes) => {
        written.push({ plan, breps: [...bytes.keys()] });
        return { status: 'ok', step: new TextEncoder().encode('ISO-10303-21;\nHEADER;') };
      },
    });
    for (const [h, d] of fixture.closure) kept.set(h, d);
    await controller.refresh();
    // Parts still evaluating are boxes: no file of them yet.
    expect(await assembly.exportStep('Cart')).toBeUndefined();
    expect(controller.getSnapshot().diagnostic?.message).toBe(describeCode('step-parts-pending'));
    await port.idle();
    const file = await assembly.exportStep('Cart');
    // The plate and the shaft have shapes; the pair and the root only place them.
    expect(breps).toEqual([fixture.plate.contentHash, fixture.shaft.contentHash]);
    expect(written).toHaveLength(1);
    expect(written[0]!.breps).toEqual(breps);
    expect(written[0]!.plan.products.map((p) => p.name)).toEqual([
      'Plate',
      'Shaft',
      'Pair',
      'Cart',
    ]);
    expect(file?.report).toMatchObject({
      format: 'step',
      units: 'mm',
      products: 4,
      instances: 2 + 4,
      sourceContentHash: controller.getSnapshot().contentHash,
    });
    // STL and GLB stay refused for an assembly.
    expect(await controller.exportMesh('stl')).toBeUndefined();
    expect(controller.getSnapshot().diagnostic?.message).toBe(
      describeCode('assembly-export-unsupported'),
    );
    // A part the Host no longer lets this user read is not written, before any evaluation.
    access.delete('shaft');
    expect(await assembly.exportStep('Cart')).toBeUndefined();
    expect(controller.getSnapshot().diagnostic?.message).toBe(
      describeCode('step-part-unavailable'),
    );
    expect(written).toHaveLength(1);
  });
});

describe('STEP AP242 assembly import into an empty document (R2b-5, R2b-U7)', () => {
  const sha = (c: string) => `sha256:${c.repeat(64)}`;
  const result = (instances: number) => ({
    status: 'ok' as const,
    read: {
      shapes: [
        {
          name: 'Wheel',
          product: { id: 'W-1', name: 'Wheel', description: '' },
          kind: 'solid' as const,
          brep: { sha256: sha('b'), byteLength: 2 },
          boundsMm: [
            [0, 0, 0],
            [10, 10, 10],
          ] as [[number, number, number], [number, number, number]],
        },
      ],
      instances: Array.from({ length: instances }, (_, i) => ({
        shape: 0,
        path: ['Axle', `Wheel ${i + 1}`],
        pose: {
          translationMm: [i * 20, 0, 0] as [number, number, number],
          rotation: [0, 0, 0, 1] as [number, number, number, number],
        },
      })),
      skipped: ['Label'],
    },
    report: {
      source: { sha256: sha('c'), byteLength: 3, schema: 'AP242' as const, fileSchema: 'AP242' },
      importerBuildHash: fixtureKernel.buildHash,
      sourceUnit: 'mm' as const,
      scaleToMm: 1,
      split: [],
      depth: 2,
      healing: 'none' as const,
      losses: ['appearance' as const, 'nesting' as const],
    },
    breps: [new Uint8Array([1, 2])],
  });

  it('previews the read file, stores its assets and parts, then places every instance in one edit', async () => {
    const reads: number[] = [];
    const { controller, assembly, session, stages, kept } = setup({
      importStepAssembly: async (_profile, _id, bytes) => {
        reads.push(bytes.length);
        return result(3);
      },
    });
    await controller.refresh();
    expect(await assembly.prepareStepImport('cart.step', new Uint8Array(3))).toBe(true);
    expect(assembly.getSnapshot().stepImport).toMatchObject({
      fileName: 'cart.step',
      parts: 1,
      components: 3,
      skipped: ['Label'],
    });
    // Nothing is stored before the import is adopted.
    expect(stages).toEqual([]);
    assembly.cancelStepImport();
    expect(assembly.getSnapshot().stepImport).toBeUndefined();
    await assembly.prepareStepImport('cart.step', new Uint8Array(3));
    expect(await assembly.adoptStepImport()).toBe(true);
    // The source and the BRep once, with the part document, before the edit names them.
    expect(stages).toEqual([[1, 2]]);
    const doc = session.content;
    expect(doc.parts).toHaveLength(1);
    expect(doc.parts[0]!.source.kind).toBe('imported');
    expect(kept.has(doc.parts[0]!.source.contentHash)).toBe(true);
    expect(doc.components.map((c) => c.name)).toEqual([
      'Axle / Wheel 1',
      'Axle / Wheel 2',
      'Axle / Wheel 3',
    ]);
    expect(doc.solvedPoses[doc.components[2]!.id]!.translationMm).toEqual([40, 0, 0]);
    // One Undo removes the whole import.
    session.undo();
    expect(session.content.components).toEqual([]);
    expect(reads).toEqual([3, 3]);
  });

  it('goes to the assembly import when the single import finds assembly usages', async () => {
    const { controller, assembly } = setup({ importStepAssembly: async () => result(2) });
    await controller.refresh();
    await controller.prepareStepImport('cart.step', new Uint8Array(3), {
      assembly: () => assembly.prepareStepImport('cart.step', new Uint8Array(3)),
    });
    expect(controller.getSnapshot().stepImport).toBeUndefined();
    expect(controller.getSnapshot().diagnostic).toBeUndefined();
    expect(assembly.getSnapshot().stepImport?.components).toBe(2);
  });

  it('refuses the import when an edit lands while the Host stores its files', async () => {
    const during: { edit?: () => Promise<unknown> } = {};
    const { controller, assembly, session } = setup({
      importStepAssembly: async () => result(2),
      onStage: async () => void (await during.edit?.()),
    });
    const plate = r2bParts().plate.content;
    during.edit = () =>
      controller.run({
        type: 'insertFeatures',
        parameters: plate.parameters,
        profiles: plate.profiles,
        sketches: plate.sketches,
        features: plate.features,
      });
    await controller.refresh();
    await assembly.prepareStepImport('cart.step', new Uint8Array(3));
    expect(await assembly.adoptStepImport()).toBe(false);
    expect(controller.getSnapshot().diagnostic?.message).toBe(
      describeCode('step-assembly-not-empty'),
    );
    expect(session.content.components).toEqual([]);
  });

  it('refuses a document with content, a read-only one and a refused read, storing nothing', async () => {
    const { controller, assembly, stages } = setup({
      doc: r2bParts().assembly,
      importStepAssembly: async () => result(1),
    });
    await controller.refresh();
    expect(await assembly.prepareStepImport('cart.step', new Uint8Array(3))).toBe(false);
    expect(controller.getSnapshot().diagnostic?.message).toBe(
      describeCode('step-assembly-not-empty'),
    );
    const empty = setup({
      importStepAssembly: async () => ({ status: 'rejected', code: 'step-instance-transform' }),
    });
    await empty.controller.refresh();
    expect(await empty.assembly.prepareStepImport('m.step', new Uint8Array(3))).toBe(false);
    expect(empty.controller.getSnapshot().diagnostic?.message).toContain(
      describeCode('step-instance-transform'),
    );
    expect(empty.assembly.getSnapshot().stepImport).toBeUndefined();
    // Without the Host's asset storage there is no import.
    const plain = setup();
    await plain.controller.refresh();
    expect(await plain.assembly.prepareStepImport('m.step', new Uint8Array(3))).toBe(false);
    expect(plain.controller.getSnapshot().diagnostic?.message).toBe(
      describeCode('step-import-unavailable'),
    );
    expect([...stages, ...empty.stages, ...plain.stages]).toEqual([]);
  });
});
