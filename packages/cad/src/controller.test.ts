import { EditorSession } from '@editor-platform/editor-core';
import { describe, expect, it } from 'vitest';
import {
  applyCadOperation,
  k5aBars,
  cadToleranceSets,
  f02Plate,
  f11Bracket,
  f15Loft,
  f15Sweep,
  f17Boundaries,
  f18Hood,
  f17Surfaces,
  fixtureKernel,
  identityQuaternion,
  mm,
  position,
  type CadDocument,
  type CadFeature,
  type CadReferenceProblem,
  type CadTopoName,
  type CadTopologyRef,
  type CadEvaluateRequest,
  type CadEvaluation,
  type CadKernelPort,
  type CadNamedView,
  type CadContinuitySample,
  type CadCombSample,
  cadContentHash,
} from '@editor-platform/cad-core';
import type { CadMesh } from '@editor-platform/cad-kernel-occt';
import { cadInputState } from './binding';
import {
  CadController,
  describeCode,
  referenceRows,
  retainedBytes,
  topologyInfo,
  type CadControllerOptions,
} from './controller';

/**
 * Kernel that answers immediately; `fail` turns the next answer into a geometry error. With
 * `meshes`, every successful evaluation also delivers an (empty) mesh like the Worker port does.
 */
function setup(
  canEdit = true,
  meshes = false,
  doc: CadDocument = f02Plate(),
  budget?: { mainBytes: number },
  extra: Partial<CadControllerOptions> = {},
) {
  const auth = { canEdit };
  /** What each successful evaluation delivers when `meshes` is on. */
  const delivered: { meshes: CadMesh[] } = { meshes: [] };
  /** Failures for the next evaluations, in order. */
  const fails: {
    code: string;
    featureId?: string;
    retryable: boolean;
    references?: unknown[];
    edges?: unknown[];
  }[] = [];
  const requests: CadEvaluateRequest[] = [];
  const kernel: CadKernelPort = {
    evaluate: async (request) => {
      requests.push(request);
      const failure = fails.shift();
      if (!failure && meshes) controller.receiveMeshes(request.candidateHash, delivered.meshes);
      return (
        failure
          ? { status: 'error', contentHash: request.candidateHash, ...failure }
          : {
              status: 'ok',
              contentHash: request.candidateHash,
              buildHash: fixtureKernel.buildHash,
              geometryDigest: 'digest',
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
                      ],
                    },
                  ]),
              ),
            }
      ) as CadEvaluation;
    },
    cancel: () => {},
  };
  let n = 0;
  const session = new EditorSession(doc);
  const controller = new CadController({
    session,
    kernel,
    canEdit: () => auth.canEdit,
    permissionGeneration: () => 1,
    newId: (prefix) => `${prefix}-${++n}`,
    ...(budget ? { budget } : {}),
    ...extra,
  });
  const failNext = (
    code: string,
    featureId?: string,
    retryable = false,
    references?: CadReferenceProblem[],
    edges?: { featureId: string; name: CadTopoName }[],
  ) =>
    fails.push({
      code,
      ...(featureId ? { featureId } : {}),
      retryable,
      ...(references ? { references } : {}),
      ...(edges ? { edges } : {}),
    });
  return { controller, session, auth, requests, failNext, delivered };
}

describe('CadController', () => {
  const sideView = (): Pick<CadNamedView, 'camera' | 'projection'> => ({
    camera: { position: [0, -200, 0], target: [40, 25, 0], up: [0, 0, 1] },
    projection: { type: 'orthographic', spanMm: 120 },
  });

  it('saves the camera and shown bodies as one named view edit (ST-27#11)', async () => {
    const { controller, session } = setup();
    await controller.refresh();
    expect(await controller.saveView(sideView(), ['plate'])).toBe('view-1');
    expect(controller.getSnapshot().content.namedViews).toEqual([
      { id: 'view-1', name: 'View 1', bodyIds: ['plate'], ...sideView() },
    ]);
    expect(session.canUndo).toBe(true);
    await controller.undo();
    expect(controller.getSnapshot().content.namedViews).toEqual([]);
    await controller.redo();
    expect(controller.getSnapshot().content.namedViews.map((v) => v.id)).toEqual(['view-1']);
  });

  it('refuses Save view when read-only and keeps the content', async () => {
    const { controller } = setup(false);
    const before = controller.getSnapshot().contentHash;
    expect(await controller.saveView(sideView(), ['plate'])).toBeUndefined();
    expect(controller.getSnapshot().diagnostic?.code).toBe('permission-denied');
    expect(controller.getSnapshot().contentHash).toBe(before);
  });

  it('describes a duplicate ID with both places (ST-28#7)', () => {
    expect(
      describeCode(
        'cad-invalid:duplicate-id@$.bodies[1].id (ID "glass" is already used at $.profiles[3].id)',
      ),
    ).toBe(
      'ID「glass」が $.profiles[3].id と $.bodies[1].id で重複しています。body・feature・profile・parameter・named view の ID は文書の中で 1 つずつにしてください。',
    );
  });

  it('applies a prepared edit as one history entry and notifies subscribers', async () => {
    const { controller, session } = setup();
    await controller.refresh();
    let notified = 0;
    controller.subscribe(() => notified++);
    expect(await controller.run({ type: 'setParameter', parameterId: 'W', value: 100 })).toBe(true);
    expect(notified).toBeGreaterThan(0);
    expect(controller.getSnapshot().content.parameters.find((p) => p.id === 'W')?.value).toBe(100);
    expect(session.canUndo).toBe(true);
    expect(controller.getSnapshot().busy).toBe(false);
  });

  it('reports a geometry error in Japanese, keeps content and bumps rejections', async () => {
    const { controller, session, failNext } = setup();
    await controller.refresh();
    const before = controller.getSnapshot();
    failNext('multiple-solids');
    expect(await controller.run({ type: 'setParameter', parameterId: 'W', value: 1 })).toBe(false);
    const after = controller.getSnapshot();
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.rejections).toBe(before.rejections + 1);
    expect(after.diagnostic?.message).toBe(describeCode('multiple-solids'));
    expect(session.canUndo).toBe(false);
    controller.dismissDiagnostic();
    expect(controller.getSnapshot().diagnostic).toBeUndefined();
  });

  it('names the reason and the feature or body when the shape cannot be calculated (ST-28#9)', async () => {
    const { controller, failNext } = setup();
    failNext('output-limit', 'plate');
    await controller.refresh();
    const plate = controller.getSnapshot().content.bodies.find((b) => b.id === 'plate')!;
    expect(controller.getSnapshot()).toMatchObject({
      geometryState: 'geometry-error',
      geometryFailure: `表示できる形状の上限を超えています。原因：body「${plate.name}」`,
    });
    // Recalculate clears it once the kernel answers.
    await controller.refresh({ retry: true });
    expect(controller.getSnapshot()).toMatchObject({
      geometryState: 'ready',
      geometryFailure: undefined,
    });
  });

  it('shows a retryable failure the same way; an unknown ID names nothing (ST-28#9)', async () => {
    const { controller, failNext } = setup();
    failNext('kernel-unavailable', 'gone', true);
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({
      geometryState: 'geometry-error',
      evaluation: undefined,
      geometryFailure: '形状計算を開始できません。再計算を試してください。',
    });
  });

  it('names a feature that exists only in the refused edit (ST-28#9)', async () => {
    const { controller, session, failNext } = setup();
    await controller.refresh();
    failNext('timeout', 'sphere-1');
    expect(await controller.addPrimitive('sphere')).toBe(false);
    expect(controller.getSnapshot().diagnostic?.message).toBe(
      '形状計算が時間内に終わりませんでした。大きなBooleanやpatternを小さく分けるか、要素の数を減らしてください。原因：feature「Sphere」',
    );
    expect(session.content.features.some((f) => f.id === 'sphere-1')).toBe(false);
    expect(controller.getSnapshot().geometryState).toBe('ready');
  });

  it('explains disconnected results, the tolerance and known kernel exceptions with what to change (ST-85#1)', () => {
    expect(describeCode('multiple-solids')).toContain('1,024');
    // K1 (CM-5): the other refusals of a body of several solids.
    expect(describeCode('limit-solids')).toContain('4,096');
    expect(describeCode('solids-touching')).toContain('接する');
    expect(describeCode('shell-multiple-solids')).toContain('殻にできません');
    expect(describeCode('result-tolerance')).toContain('0.0001 mm');
    const loft = describeCode(
      'kernel-exception:Standard_ConstructionError:BRepFill :: profiles are inconsistent',
    );
    expect(loft).toContain('loftの断面');
    expect(loft).not.toContain('BRepFill');
    expect(
      describeCode(
        'kernel-exception:Standard_NoSuchObject:BRepFill_CompatibleWires::SameNumberByPolarMethod failed',
      ),
    ).toBe(loft);
    expect(describeCode('kernel-exception:Standard_Failure')).toBe(
      'この寸法では形状を作れません。',
    );
  });

  it('rejects edits without permission before preparing', async () => {
    const { controller, requests } = setup(false);
    expect(await controller.run({ type: 'rename', targetId: 'plate', name: 'x' })).toBe(false);
    expect(controller.getSnapshot().diagnostic?.code).toBe('permission-denied');
    expect(controller.getSnapshot().readOnly).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it('places a new primitive beside the evaluated bodies and drops a stale selection on undo', async () => {
    const { controller } = setup();
    await controller.refresh();
    await controller.addPrimitive('box');
    const box = controller.getSnapshot().content.features.find((f) => f.type === 'box');
    expect(box?.type === 'box' && box.args.origin).toEqual([
      { literalMm: 90 },
      { literalMm: 0 },
      { literalMm: 0 },
    ]);
    const body = controller.getSnapshot().content.bodies.find((b) => b.name === 'Box')!;
    expect(controller.isMovable(body)).toBe(true);
    controller.select({ kind: 'body', id: body.id });
    await controller.undo();
    expect(controller.getSnapshot().selection).toBeNull();
  });

  it('adds a disc, a prism and a ring from profiles, each as one edit (CAD15)', async () => {
    const { controller, session } = setup();
    await controller.refresh();
    expect(await controller.addDisc()).toBe(true);
    expect(await controller.addPrism()).toBe(true);
    expect(await controller.addRing()).toBe(true);
    const doc = controller.getSnapshot().content;
    const shapeOf = (name: string) => doc.profiles.find((p) => p.id === profileOf(name))!.shape;
    const profileOf = (name: string) => {
      const f = doc.features.find((x) => x.name === name)!;
      return (f.type === 'extrude' || f.type === 'revolve') && 'profileId' in f.args
        ? f.args.profileId
        : '';
    };
    expect(shapeOf('Disc')).toEqual({ type: 'circle', radius: { literalMm: 15 } });
    // The plate ends at X = 80: the disc starts 10 mm past it, as a box would.
    const disc = doc.profiles.find((p) => p.id === profileOf('Disc'))!;
    expect(disc.plane.origin).toEqual([{ literalMm: 105 }, { literalMm: 0 }, { literalMm: 0 }]);
    const prism = shapeOf('Prism');
    expect(prism.type === 'polyline' && prism.vertices.map((v) => [v.u, v.v])).toEqual(
      [
        [0, 0],
        [40, 0],
        [40, 10],
        [10, 10],
        [10, 30],
        [0, 30],
      ].map(([u, v]) => [{ literalMm: u }, { literalMm: v }]),
    );
    const ring = doc.features.find((f) => f.name === 'Ring')!;
    expect(ring.type === 'revolve' && ring.args.angle).toEqual({ literalRad: 2 * Math.PI });
    expect(doc.bodies.slice(-3).map((b) => b.name)).toEqual(['Disc', 'Prism', 'Ring']);
    // Each button is one history entry.
    await controller.undo();
    expect(controller.getSnapshot().content.bodies.map((b) => b.name)).not.toContain('Ring');
    expect(session.canUndo).toBe(true);
  });

  it('duplicates a body with its whole closure under new IDs, as one edit (CAD15, CAD06)', async () => {
    const { controller, session } = setup();
    await controller.refresh();
    const before = controller.getSnapshot().content;
    expect(await controller.duplicateBody('plate')).toBe(true);
    const after = controller.getSnapshot().content;
    // F02's plate, its hole tool, both profiles, the width parameter and every feature.
    expect(after.bodies).toHaveLength(before.bodies.length * 2);
    expect(after.features).toHaveLength(before.features.length * 2);
    expect(after.profiles).toHaveLength(before.profiles.length * 2);
    expect(after.parameters).toHaveLength(before.parameters.length * 2);
    const copy = controller.getSnapshot().selection;
    expect(copy).toMatchObject({ kind: 'body' });
    expect(copy!.id).not.toBe('plate');
    expect(after.bodies.find((b) => b.id === copy!.id)).toMatchObject({
      name: before.bodies.find((b) => b.id === 'plate')!.name,
      state: 'active',
    });
    await controller.undo();
    expect(controller.getSnapshot().content).toEqual(before);
    expect(session.canUndo).toBe(false);
    // A consumed tool is not copied on its own.
    expect(await controller.duplicateBody('hole')).toBe(false);
    expect(controller.getSnapshot().diagnostic?.code).toBe('body-consumed');
  });

  it('keeps meshes per content hash and marks older meshes as not current', async () => {
    const { controller } = setup();
    await controller.refresh();
    const first = controller.getSnapshot().contentHash;
    controller.receiveMeshes(first, []);
    expect(controller.getSnapshot().meshes).toMatchObject({ contentHash: first, current: true });
    await controller.run({ type: 'setParameter', parameterId: 'W', value: 90 });
    expect(controller.getSnapshot().meshes).toMatchObject({ contentHash: first, current: false });
  });

  it('refuses Undo and Redo without edit authority', async () => {
    const { controller, session, auth } = setup();
    await controller.refresh();
    await controller.run({ type: 'setParameter', parameterId: 'W', value: 100 });
    auth.canEdit = false;
    await controller.undo();
    expect(controller.getSnapshot().diagnostic?.code).toBe('permission-denied');
    expect(controller.getSnapshot().content.parameters[0].value).toBe(100);
    auth.canEdit = true;
    await controller.undo();
    auth.canEdit = false;
    await controller.redo();
    expect(session.canRedo).toBe(true);
    expect(controller.getSnapshot().content.parameters[0].value).toBe(80);
  });

  it('keeps the mesh of every evaluation the coordinator still caches', async () => {
    const { controller } = setup(true, true);
    const width = (value: number) =>
      controller.run({ type: 'setParameter', parameterId: 'W', value });
    await controller.refresh(); // A
    await width(90); // B
    await width(100); // C
    await controller.undo(); // B
    await width(110); // D
    await controller.undo(); // B
    await width(120); // E
    await controller.undo(); // B: cached evaluation, so no new kernel job
    const snapshot = controller.getSnapshot();
    expect(snapshot.geometryState).toBe('ready');
    expect(snapshot.meshes).toMatchObject({ contentHash: snapshot.contentHash, current: true });
  });

  it('a superseded edit never clears busy while the newer one is pending', async () => {
    const jobs: { request: CadEvaluateRequest; resolve(e: CadEvaluation): void }[] = [];
    const controller = new CadController({
      session: new EditorSession(f02Plate()),
      kernel: {
        evaluate: (request) => new Promise((resolve) => jobs.push({ request, resolve })),
        cancel: () => {},
      },
      canEdit: () => true,
      permissionGeneration: () => 1,
    });
    const answer = (i: number) =>
      jobs[i].resolve({
        status: 'ok',
        contentHash: jobs[i].request.candidateHash,
        buildHash: fixtureKernel.buildHash,
        geometryDigest: 'digest',
        bodies: {},
      });
    const first = controller.run({ type: 'setParameter', parameterId: 'W', value: 90 });
    const second = controller.run({ type: 'setParameter', parameterId: 'W', value: 100 });
    answer(0);
    expect(await first).toBe(false);
    expect(controller.getSnapshot().busy).toBe(true);
    answer(1);
    expect(await second).toBe(true);
    expect(controller.getSnapshot().busy).toBe(false);
    // Superseded by a newer run: no Inspector reset.
    expect(controller.getSnapshot().rejections).toBe(0);
  });

  it('an edit cancelled by Undo resets the Inspector', async () => {
    const jobs: { request: CadEvaluateRequest; resolve(e: CadEvaluation): void }[] = [];
    const controller = new CadController({
      session: new EditorSession(f02Plate()),
      kernel: {
        evaluate: (request) => new Promise((resolve) => jobs.push({ request, resolve })),
        cancel: () => {},
      },
      canEdit: () => true,
      permissionGeneration: () => 1,
    });
    const answer = (i: number) =>
      jobs[i].resolve({
        status: 'ok',
        contentHash: jobs[i].request.candidateHash,
        buildHash: fixtureKernel.buildHash,
        geometryDigest: 'digest',
        bodies: {},
      });
    const first = controller.run({ type: 'setParameter', parameterId: 'W', value: 90 });
    answer(0);
    expect(await first).toBe(true);
    const pending = controller.run({ type: 'setParameter', parameterId: 'W', value: 100 });
    void controller.undo();
    answer(1);
    expect(await pending).toBe(false);
    expect(controller.getSnapshot().rejections).toBe(1);
  });

  it('Recalculate re-evaluates a cached timeout; a plain refresh does not', async () => {
    const { controller, requests, failNext } = setup();
    failNext('timeout');
    await controller.refresh();
    expect(controller.getSnapshot().geometryState).toBe('geometry-error');
    await controller.refresh();
    expect(requests).toHaveLength(1);
    await controller.refresh({ retry: true });
    expect(requests).toHaveLength(2);
    expect(controller.getSnapshot().geometryState).toBe('ready');
  });
});

describe('CadController tolerance set (K2, CM-6)', () => {
  it('evaluates the whole model with the other set, shows the difference and adopts it as one edit', async () => {
    const { controller, session, requests, failNext } = setup();
    // The shown shape failed with the standard set, as the airliner's wing union does.
    failNext('result-tolerance', 'plate-extrude');
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({
      geometryState: 'geometry-error',
      toleranceSet: 'standard',
      canChangeTolerance: true,
    });
    const before = structuredClone(session.content);
    const preview = await controller.prepareToleranceSet('large');
    expect(preview).toMatchObject({
      tolerance: { from: 'standard', to: 'large' },
      shownCode: 'result-tolerance',
      bodies: [{ id: 'plate', next: { volumeMm3: 1 } }],
    });
    expect(preview!.bodies[0]).not.toHaveProperty('shown');
    // The whole graph went to the kernel with the large values; nothing is applied yet.
    expect(requests.at(-1)!.document.kernelProfile).toMatchObject(cadToleranceSets.large);
    expect(session.content).toEqual(before);
    expect(controller.getSnapshot().canChangeTolerance).toBe(false);
    controller.cancelMigration();
    expect(session.canUndo).toBe(false);
    await controller.prepareToleranceSet('large');
    expect(controller.adoptMigration()).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      toleranceSet: 'large',
      geometryState: 'ready',
    });
    await controller.undo();
    expect(session.content).toEqual(before);
    expect(controller.getSnapshot().toleranceSet).toBe('standard');
  });

  it('refuses a set whose evaluation fails, and one without edit authority', async () => {
    const { controller, session, auth, failNext } = setup();
    await controller.refresh();
    failNext('invalid-solid', 'plate-extrude');
    expect(await controller.prepareToleranceSet('large')).toBeUndefined();
    expect(controller.getSnapshot().diagnostic?.code).toBe('invalid-solid');
    expect(await controller.prepareToleranceSet('standard')).toBeUndefined();
    expect(controller.getSnapshot().diagnostic?.code).toBe('tolerance-set-unchanged');
    auth.canEdit = false;
    expect(await controller.prepareToleranceSet('large')).toBeUndefined();
    expect(controller.getSnapshot()).toMatchObject({
      canChangeTolerance: false,
      diagnostic: { code: 'permission-denied' },
    });
    expect(session.content.kernelProfile).toMatchObject(cadToleranceSets.standard);
  });
});

describe('CadController kernel update (CAD17, ST-31)', () => {
  /** The fixture document is on an earlier build; the Host shows it with `newer` as reference. */
  function referenceSetup(canEdit = true) {
    const newer = { id: 'newer-kernel', buildHash: `sha256:${'b'.repeat(64)}` };
    const kernel: CadKernelPort = {
      evaluate: async (request) => {
        const exact = request.document.kernelProfile.buildHash === newer.buildHash;
        controller.receiveMeshes(request.candidateHash, []);
        return {
          status: 'ok',
          contentHash: request.candidateHash,
          buildHash: newer.buildHash,
          geometryDigest: 'digest',
          bodies: {
            plate: {
              // The two evaluations differ slightly, as a real kernel update may.
              kind: 'solid' as const,
              volumeMm3: exact ? 19_607 : 19_608,
              areaMm2: 1,
              bounds: [
                [0, 0, 0],
                [80, 50, 5],
              ],
            },
          },
          ...(exact ? {} : { reference: true }),
        };
      },
      cancel: () => {},
    };
    const session = new EditorSession(f02Plate());
    const controller = new CadController({
      session,
      kernel,
      canEdit: () => canEdit,
      permissionGeneration: () => 1,
      currentKernel: newer,
    });
    return { controller, session, newer };
  }

  it('shows a read-only reference: no edits, no export, the saved content unchanged', async () => {
    const { controller, session } = referenceSetup();
    const saved = structuredClone(session.content);
    await controller.refresh();
    const snapshot = controller.getSnapshot();
    expect(snapshot.reference).toEqual({ effectiveBuildHash: `sha256:${'b'.repeat(64)}` });
    expect(snapshot).toMatchObject({ readOnly: true, canEdit: true, canMigrate: true });
    expect(await controller.addPrimitive('box')).toBe(false);
    expect(controller.getSnapshot().diagnostic?.code).toBe('kernel-reference-only');
    expect(await controller.exportMesh('glb')).toBeUndefined();
    expect(controller.getSnapshot().diagnostic?.code).toBe('kernel-reference-only');
    expect(session.content).toEqual(saved);
  });

  it('migrates explicitly as one edit; Undo returns to the reference display', async () => {
    const { controller, session, newer } = referenceSetup();
    await controller.refresh();
    const before = structuredClone(session.content);
    // Preparing shows the new build's exact result; nothing changes until it is adopted.
    const preview = await controller.prepareMigration();
    expect(preview).toMatchObject({
      toBuildHash: newer.buildHash,
      bodies: [{ id: 'plate', shown: { volumeMm3: 19_608 }, next: { volumeMm3: 19_607 } }],
    });
    expect(controller.getSnapshot().migration).toBe(preview);
    expect(session.content).toEqual(before);
    controller.cancelMigration();
    expect(controller.getSnapshot().migration).toBeUndefined();
    expect(session.canUndo).toBe(false);
    await controller.prepareMigration();
    expect(controller.adoptMigration()).toBe(true);
    expect(session.content.kernelProfile).toMatchObject(newer);
    expect(controller.getSnapshot()).toMatchObject({
      reference: undefined,
      readOnly: false,
      canMigrate: false,
    });
    await controller.undo();
    expect(controller.getSnapshot().reference).toBeDefined();
    await controller.redo();
    expect(controller.getSnapshot().reference).toBeUndefined();
  });

  it('offers no migration without edit authority', async () => {
    const { controller, session } = referenceSetup(false);
    await controller.refresh();
    expect(controller.getSnapshot().canMigrate).toBe(false);
    expect(await controller.prepareMigration()).toBeUndefined();
    expect(controller.adoptMigration()).toBe(false);
    expect(session.content.kernelProfile.buildHash).toBe(fixtureKernel.buildHash);
  });
});

/** A mesh of 4,000 bytes of positions. */
const big = (): CadMesh => ({
  bodyId: 'plate',
  origin: [0, 0, 0],
  positions: new Float32Array(1000),
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

describe('CadController memory budget (CAD26)', () => {
  /** A mesh holding `bytes` of positions; `shared` reuses one buffer. */
  const mesh = (bytes: number, shared?: Float32Array): CadMesh => ({
    bodyId: 'plate',
    origin: [0, 0, 0],
    positions: shared ?? new Float32Array(bytes / 4),
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
  /** Width W → mesh bytes; the kernel answers every request with meshes of that size. */
  function budgeted(
    sizes: (width: number) => number,
    mainBytes = 1000,
    mainEntries?: number,
    options: Partial<CadControllerOptions> = {},
  ) {
    const requests: number[] = [];
    const auth = { canEdit: true };
    let gate: Promise<void> | undefined;
    const kernel: CadKernelPort = {
      evaluate: async (request) => {
        const width = request.document.parameters.find((p) => p.id === 'W')!.value!;
        requests.push(width);
        await gate;
        controller.receiveMeshes(request.candidateHash, [mesh(sizes(width))]);
        return {
          status: 'ok',
          contentHash: request.candidateHash,
          buildHash: fixtureKernel.buildHash,
          geometryDigest: 'digest',
          bodies: {},
        } as CadEvaluation;
      },
      cancel: () => {},
    };
    const session = new EditorSession(f02Plate());
    const controller = new CadController({
      session,
      kernel,
      canEdit: () => auth.canEdit,
      permissionGeneration: () => 1,
      budget: { mainBytes, ...(mainEntries ? { mainEntries } : {}) },
      ...options,
    });
    const widen = (value: number) =>
      controller.run({ type: 'setParameter', parameterId: 'W', value });
    const hold = () => {
      let open = () => {};
      gate = new Promise((resolve) => (open = resolve));
      return () => {
        gate = undefined;
        open();
      };
    };
    return { controller, session, requests, auth, widen, hold };
  }
  const shownWidth = (c: CadController) =>
    c.getSnapshot().meshes?.current ? c.getSnapshot().content.parameters[0].value : undefined;

  it('counts a buffer shared by several meshes once', () => {
    const buffer = new Float32Array(100);
    expect(retainedBytes([mesh(0, buffer), mesh(0, buffer), mesh(40)])).toBe(440);
  });

  it('drops history meshes first, least recent first; returning to one evaluates it again', async () => {
    const { controller, session, requests, widen } = budgeted(() => 400);
    await controller.refresh();
    for (const w of [81, 82, 83]) expect(await widen(w)).toBe(true);
    // 400 bytes each against 1,000: two fit, the older history (W=80, then W=81) went first.
    expect(controller.retainedMeshBytes).toBe(800);
    expect(controller.coordinator.cachedContentHashes()).toHaveLength(2);
    expect(requests).toEqual([80, 81, 82, 83]);
    session.undo();
    session.undo();
    session.undo();
    await controller.sync();
    // W=80 was released with its evaluation: shown again only after evaluating it again.
    expect(requests).toEqual([80, 81, 82, 83, 80]);
    expect(shownWidth(controller)).toBe(80);
    expect(controller.retainedMeshBytes).toBeLessThanOrEqual(1000);
    expect(session.canRedo).toBe(true);
  });

  it('releases the current display for a candidate that needs the room, and shows it again if it does not apply', async () => {
    const { controller, session, requests, auth, widen, hold } = budgeted(() => 600);
    await controller.refresh();
    const release = hold();
    const pending = widen(90);
    auth.canEdit = false;
    release();
    // The candidate's meshes arrived, the current ones were released, then the apply was refused.
    expect(await pending).toBe(false);
    auth.canEdit = true;
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve));
    expect(requests).toEqual([80, 90, 80]);
    expect(shownWidth(controller)).toBe(80);
    expect(session.canUndo).toBe(false);
    // Applied, the candidate simply becomes the current display.
    expect(await widen(95)).toBe(true);
    expect(shownWidth(controller)).toBe(95);
    expect(controller.retainedMeshBytes).toBe(600);
  });

  it('refuses a migration that does not fit, and shows the current shape again after a cancelled one', async () => {
    const newer = { id: 'newer-kernel', buildHash: `sha256:${'b'.repeat(64)}` };
    let migrated = 2000;
    const kernel: CadKernelPort = {
      evaluate: async (request) => {
        const exact = request.document.kernelProfile.buildHash === newer.buildHash;
        controller.receiveMeshes(request.candidateHash, [mesh(exact ? migrated : 600)]);
        return {
          status: 'ok',
          contentHash: request.candidateHash,
          buildHash: newer.buildHash,
          geometryDigest: 'digest',
          bodies: {},
          ...(exact ? {} : { reference: true }),
        } as CadEvaluation;
      },
      cancel: () => {},
    };
    const session = new EditorSession(f02Plate());
    const controller = new CadController({
      session,
      kernel,
      canEdit: () => true,
      permissionGeneration: () => 1,
      currentKernel: newer,
      budget: { mainBytes: 1000 },
    });
    await controller.refresh();
    const shown = () => !!controller.getSnapshot().meshes?.current;
    // 2,000 bytes against 1,000: no preview to adopt; content, history and display stay.
    expect(await controller.prepareMigration()).toBeUndefined();
    expect(controller.getSnapshot().diagnostic?.code).toBe('memory-budget');
    expect(controller.adoptMigration()).toBe(false);
    expect(session.canUndo).toBe(false);
    expect(shown()).toBe(true);
    // 600 + 600 against 1,000: preparing releases the current display; cancelling restores it.
    migrated = 600;
    expect(await controller.prepareMigration()).toBeDefined();
    controller.cancelMigration();
    await new Promise((resolve) => setTimeout(resolve));
    expect(shown()).toBe(true);
    expect(controller.getSnapshot().geometryState).toBe('ready');
    expect(session.canUndo).toBe(false);
  });

  it('shows the migrated shape again when a refresh of the old build finishes after the migration', async () => {
    const newer = { id: 'newer-kernel', buildHash: `sha256:${'b'.repeat(64)}` };
    let late: (() => void) | undefined;
    const evaluated: string[] = [];
    const kernel: CadKernelPort = {
      evaluate: async (request) => {
        const exact = request.document.kernelProfile.buildHash === newer.buildHash;
        evaluated.push(exact ? 'new' : 'old');
        // The old build's first refresh is slow: it ends after the migration was adopted.
        if (!exact) await new Promise<void>((resolve) => (late = resolve));
        controller.receiveMeshes(request.candidateHash, [mesh(600)]);
        return {
          status: 'ok',
          contentHash: request.candidateHash,
          buildHash: newer.buildHash,
          geometryDigest: 'digest',
          bodies: {},
          ...(exact ? {} : { reference: true }),
        } as CadEvaluation;
      },
      cancel: () => {},
    };
    const session = new EditorSession(f02Plate());
    const controller = new CadController({
      session,
      kernel,
      canEdit: () => true,
      permissionGeneration: () => 1,
      currentKernel: newer,
      budget: { mainBytes: 1000 },
    });
    const refreshed = controller.refresh();
    expect(await controller.prepareMigration()).toBeDefined();
    expect(controller.adoptMigration()).toBe(true);
    const migrated = controller.getSnapshot().contentHash;
    // 600 + 600 against 1,000: the late result displaces the migrated display for a moment.
    late!();
    await refreshed;
    await new Promise((resolve) => setTimeout(resolve));
    const snapshot = controller.getSnapshot();
    expect(snapshot.contentHash).toBe(migrated);
    expect(snapshot.meshes).toMatchObject({ contentHash: migrated, current: true });
    expect(snapshot.geometryState).toBe('ready');
    expect(controller.retainedMeshBytes).toBe(600);
  });

  it('evaluates the adopted migration again when a late refresh released its preview', async () => {
    const newer = { id: 'newer-kernel', buildHash: `sha256:${'b'.repeat(64)}` };
    let late: (() => void) | undefined;
    const kernel: CadKernelPort = {
      evaluate: async (request) => {
        const exact = request.document.kernelProfile.buildHash === newer.buildHash;
        if (!exact) await new Promise<void>((resolve) => (late = resolve));
        controller.receiveMeshes(request.candidateHash, [mesh(600)]);
        return {
          status: 'ok',
          contentHash: request.candidateHash,
          buildHash: newer.buildHash,
          geometryDigest: 'digest',
          bodies: {},
          ...(exact ? {} : { reference: true }),
        } as CadEvaluation;
      },
      cancel: () => {},
    };
    const session = new EditorSession(f02Plate());
    const controller = new CadController({
      session,
      kernel,
      canEdit: () => true,
      permissionGeneration: () => 1,
      currentKernel: newer,
      budget: { mainBytes: 1000 },
    });
    const refreshed = controller.refresh();
    expect(await controller.prepareMigration()).toBeDefined();
    // 600 + 600 against 1,000 while the preview is open: the late result releases the candidate.
    late!();
    await refreshed;
    expect(controller.adoptMigration()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve));
    const snapshot = controller.getSnapshot();
    expect(snapshot.content.kernelProfile.buildHash).toBe(newer.buildHash);
    expect(snapshot.meshes).toMatchObject({ contentHash: snapshot.contentHash, current: true });
    expect(snapshot.geometryState).toBe('ready');
  });

  it('counts the shown curvature in the budget and refuses curvature that does not fit (R2a-4)', async () => {
    let nodes = 38;
    const { controller, widen } = budgeted(() => 400, 1000, undefined, {
      analyzeCurvature: async (request) => ({
        evaluation: {
          ...(controller.getSnapshot().evaluation as Extract<CadEvaluation, { status: 'ok' }>),
          contentHash: request.candidateHash,
        },
        curvature: [
          { bodyId: 'plate', mean: new Float32Array(nodes), gauss: new Float32Array(nodes) },
        ],
      }),
    });
    await controller.refresh();
    expect(await widen(81)).toBe(true);
    expect(controller.retainedMeshBytes).toBe(800);
    // 400 + 304 fits beside the current meshes; the history entry makes room.
    expect(await controller.showCurvature()).toBeDefined();
    expect(controller.retainedMeshBytes).toBe(704);
    expect(controller.coordinator.cachedContentHashes()).toHaveLength(1);
    // 400 + 800 does not fit even alone: refused, and the earlier colours are not kept either.
    nodes = 100;
    expect(await controller.showCurvature()).toBeUndefined();
    expect(controller.getSnapshot().diagnostic?.code).toBe('curvature-budget');
    expect(controller.getSnapshot().curvature).toBeUndefined();
    expect(controller.retainedMeshBytes).toBe(400);
    // Curvature for other content is released with the edit.
    nodes = 38;
    await controller.showCurvature();
    expect(await widen(82)).toBe(true);
    expect(controller.getSnapshot().curvature).toBeUndefined();
    expect(controller.retainedMeshBytes).toBe(800);
  });

  it('keeps the entry limit while a candidate is evaluated, and shows the current shape after it', async () => {
    const { controller, widen } = budgeted(() => 400, 1000, 1);
    await controller.refresh();
    expect(controller.retainedMeshBytes).toBe(400);
    let entries = 0;
    controller.subscribe(() => {
      entries = Math.max(entries, controller.retainedMeshBytes / 400);
    });
    expect(await widen(90)).toBe(true);
    expect(entries).toBe(1);
    expect(shownWidth(controller)).toBe(90);
  });

  it('refuses an edit whose meshes alone exceed the budget and keeps content, history and display', async () => {
    const { controller, session, widen } = budgeted((w) => (w > 90 ? 2000 : 300));
    await controller.refresh();
    expect(await widen(100)).toBe(false);
    const snapshot = controller.getSnapshot();
    expect(snapshot.diagnostic?.code).toBe('memory-budget');
    expect(snapshot.content.parameters[0].value).toBe(80);
    expect(session.canUndo).toBe(false);
    expect(shownWidth(controller)).toBe(80);
    expect(controller.retainedMeshBytes).toBe(300);
  });

  describe('parameters (R1a)', () => {
    it('adds length and count parameters, selected for editing', async () => {
      const { controller, session } = setup();
      await controller.refresh();
      expect(await controller.addParameter('length')).toBe(true);
      expect(session.content.parameters.at(-1)).toEqual({
        id: 'param-1',
        name: 'Length 1',
        type: 'length',
        value: 10,
      });
      expect(controller.getSnapshot().selection).toEqual({ kind: 'parameter', id: 'param-1' });
      expect(await controller.addParameter('count')).toBe(true);
      expect(session.content.parameters.at(-1)).toMatchObject({
        name: 'Count 1',
        type: 'count',
        value: 2,
      });
      expect(
        await controller.run({
          type: 'setParameter',
          parameterId: 'W',
          expression: { postfix: [{ parameterId: 'W' }] },
        }),
      ).toBe(false);
      expect(controller.getSnapshot().diagnostic?.message).toBe(describeCode('parameter-cycle'));
    });
  });
});

describe('CadController face and edge picks (R1b, CAD31)', () => {
  /** A mesh whose pick table has the top +y edge split in two by a slot (pick ids from 10/20). */
  const picked = (bodyId = 'plate'): CadMesh => ({
    bodyId,
    origin: [0, 0, 0],
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
    faceIds: new Uint32Array(0),
    vertices: new Float64Array(0),
    faceBase: 10,
    edgeBase: 20,
    edges: new Float32Array(0),
    edgeIds: new Uint32Array(0),
    topology: {
      faces: [
        { name: ['+z'], centroid: [50, 30, 20], area: 6000 },
        { name: ['+y'], centroid: [50, 60, 10], area: 2000 },
        { name: ['tool:s', '-x'], centroid: [45, 55, 15], area: 50 },
        { name: ['tool:s', '+x'], centroid: [55, 55, 15], area: 50 },
        { name: null, centroid: [0, 0, 0], area: 1 },
      ],
      edges: [
        { faces: [0, 1], vertices: [0, 1], centroid: [22.5, 60, 20], length: 45 },
        { faces: [0, 1], vertices: [2, 3], centroid: [77.5, 60, 20], length: 45 },
        { faces: [0, 2], vertices: [1, 4], centroid: [45, 55, 20], length: 10 },
        { faces: [0, 3], vertices: [2, 5], centroid: [55, 55, 20], length: 10 },
      ],
      vertices: [],
    },
  });

  it('reads the name, how many share it and what a reference would record', () => {
    const mesh = picked();
    const at = (kind: 'face' | 'edge', pick: number) =>
      topologyInfo([mesh], { kind, id: 'plate', pick, contentHash: 'h' });
    expect(at('face', 11)).toEqual({
      kind: 'face',
      bodyId: 'plate',
      name: [['+z']],
      sameName: 1,
      select: undefined,
      size: 6000,
    });
    expect(at('edge', 21)).toMatchObject({
      name: [['+y'], ['+z']],
      sameName: 2,
      select: { adjacent: [[['+z'], ['tool:s', '-x']]] },
      size: 45,
    });
    expect(at('face', 15)).toMatchObject({ name: null, select: 'unnamed' });
    // Pick ids outside this body's range are not its elements.
    expect(at('face', 10)).toBeUndefined();
    expect(at('edge', 25)).toBeUndefined();
    expect(topologyInfo([mesh], { kind: 'body', id: 'plate' })).toBeUndefined();
  });

  it('keeps a pick only on the meshes it was made on', async () => {
    const { controller } = setup(true, true);
    await controller.refresh();
    const { contentHash } = controller.getSnapshot();
    controller.receiveMeshes(contentHash, [picked()]);
    controller.select({ kind: 'edge', id: 'plate', pick: 22, contentHash });
    expect(controller.getSnapshot().topology).toMatchObject({ name: [['+y'], ['+z']] });
    // Another content has other pick ids: the pick is dropped, not carried over.
    await controller.run({ type: 'setParameter', parameterId: 'W', value: 90 });
    expect(controller.getSnapshot().selection).toBeNull();
    expect(controller.getSnapshot().topology).toBeUndefined();
  });

  it('checks a picked edge’s continuity on the exact build, shown for that pick only (R2a-4, ST-49)', async () => {
    const calls: { bodyId: string; edge: number }[] = [];
    let answer: { samples: CadContinuitySample[] } | { code: string } = {
      samples: [0, 1, 2].map((i) => ({
        at: [i * 10, 60, 20] as [number, number, number],
        g0Mm: 0,
        g1Deg: i * 0.01,
        curvature: [0, i === 1 ? 0.05 : 0] as [number, number],
      })),
    };
    let digest = 'digest';
    const gate: { hold?: Promise<void> } = {};
    const { controller, session } = setup(true, true, f02Plate(), undefined, {
      analyzeContinuity: async (request, edge) => {
        calls.push(edge);
        await gate.hold;
        const shown = controller.getSnapshot().evaluation as Extract<
          CadEvaluation,
          { status: 'ok' }
        >;
        return {
          evaluation: { ...shown, contentHash: request.candidateHash, geometryDigest: digest },
          continuity: answer,
        };
      },
    });
    await controller.refresh();
    const { contentHash } = controller.getSnapshot();
    controller.receiveMeshes(contentHash, [picked()]);
    // Nothing picked: nothing to check.
    expect(await controller.checkContinuity()).toBeUndefined();
    expect(controller.getSnapshot().diagnostic?.code).toBe('selection-stale');
    controller.select({ kind: 'edge', id: 'plate', pick: 21, contentHash });
    const report = await controller.checkContinuity();
    // The pick id less the body's edge base: the edge's index in its pick table.
    expect(calls).toEqual([{ bodyId: 'plate', edge: 0 }]);
    expect(report).toMatchObject({ level: 'G1', samples: 3, g2: { at: [10, 60, 20] } });
    expect(controller.getSnapshot().continuity).toEqual({
      bodyId: 'plate',
      pick: 21,
      status: 'done',
      report,
    });
    // Display only: no edit, the content and its hash as they were.
    expect(cadContentHash(session.content)).toBe(contentHash);
    expect(controller.getSnapshot().contentHash).toBe(contentHash);
    expect(controller.getSnapshot().canUndo).toBe(false);
    // Another pick does not show this edge's report.
    controller.select({ kind: 'edge', id: 'plate', pick: 22, contentHash });
    expect(controller.getSnapshot().continuity).toBeUndefined();
    // An edge without two faces, in Japanese; nothing shown.
    answer = { code: 'continuity-free-edge' };
    expect(await controller.checkContinuity()).toBeUndefined();
    expect(controller.getSnapshot().diagnostic?.message).toBe(describeCode('continuity-free-edge'));
    expect(controller.getSnapshot().continuity).toBeUndefined();
    // Another shape than the one shown is never reported.
    digest = 'other';
    expect(await controller.checkContinuity()).toBeUndefined();
    expect(controller.getSnapshot().diagnostic?.code).toBe('continuity-mismatch');
    // A check whose pick changed while it ran is dropped when it answers.
    digest = 'digest';
    answer = { samples: [{ at: [0, 0, 0], g0Mm: 0, g1Deg: 0, curvature: [0, 0] }] };
    let open = () => {};
    gate.hold = new Promise((resolve) => (open = resolve));
    const running = controller.checkContinuity();
    expect(controller.getSnapshot().continuity).toMatchObject({ status: 'running', pick: 22 });
    controller.select({ kind: 'edge', id: 'plate', pick: 21, contentHash });
    open();
    expect(await running).toBeUndefined();
    expect(controller.getSnapshot().continuity).toBeUndefined();
    // Without the kernel's check the Surface cannot offer it.
    const bare = setup(true, true);
    await bare.controller.refresh();
    const hash = bare.controller.getSnapshot().contentHash;
    bare.controller.receiveMeshes(hash, [picked()]);
    bare.controller.select({ kind: 'edge', id: 'plate', pick: 21, contentHash: hash });
    expect(await bare.controller.checkContinuity()).toBeUndefined();
    expect(bare.controller.getSnapshot().diagnostic?.code).toBe('kernel-unavailable');
  });

  it('samples a picked edge’s comb and the shown nodes’ curvature, display only (R2a-4, ST-50)', async () => {
    const combs: { bodyId: string; edge: number }[] = [];
    let digest = 'digest';
    let comb: { samples: CadCombSample[] } | { code: string } = {
      samples: [0, 1, 2].map((i) => ({
        at: [i * 10, 0, 0] as [number, number, number],
        curvature: i === 1 ? 0.1 : 0,
        normal: (i === 1 ? [0, 1, 0] : [0, 0, 0]) as [number, number, number],
      })),
    };
    const gate: { hold?: Promise<void> } = {};
    const mean = new Float32Array([0.1, 0.2]);
    const gauss = new Float32Array([0.01, 0.04]);
    const evaluated = (request: CadEvaluateRequest) => {
      const shown = controller.getSnapshot().evaluation as Extract<CadEvaluation, { status: 'ok' }>;
      return { ...shown, contentHash: request.candidateHash, geometryDigest: digest };
    };
    const { controller, session } = setup(true, true, f02Plate(), undefined, {
      analyzeComb: async (request, edge) => {
        combs.push(edge);
        return { evaluation: evaluated(request), comb };
      },
      analyzeCurvature: async (request) => {
        await gate.hold;
        return { evaluation: evaluated(request), curvature: [{ bodyId: 'plate', mean, gauss }] };
      },
    });
    await controller.refresh();
    const { contentHash } = controller.getSnapshot();
    controller.receiveMeshes(contentHash, [picked()]);
    expect(await controller.sampleComb()).toBeUndefined();
    expect(controller.getSnapshot().diagnostic?.code).toBe('selection-stale');
    controller.select({ kind: 'edge', id: 'plate', pick: 22, contentHash });
    const samples = await controller.sampleComb();
    expect(combs).toEqual([{ bodyId: 'plate', edge: 1 }]);
    // The automatic scale: the longest tooth (curvature 0.1) is a fifth of the 20 mm edge.
    expect(controller.getSnapshot().comb).toEqual({
      bodyId: 'plate',
      pick: 22,
      status: 'done',
      samples,
      scale: (0.2 * 20) / 0.1,
    });
    expect(cadContentHash(session.content)).toBe(contentHash);
    expect(controller.getSnapshot().canUndo).toBe(false);
    // Only for that pick; Hide drops it.
    controller.select({ kind: 'edge', id: 'plate', pick: 21, contentHash });
    expect(controller.getSnapshot().comb).toBeUndefined();
    controller.select({ kind: 'edge', id: 'plate', pick: 22, contentHash });
    expect(controller.getSnapshot().comb).toMatchObject({ status: 'done' });
    controller.hideComb();
    expect(controller.getSnapshot().comb).toBeUndefined();
    comb = { code: 'curvature-degenerate' };
    expect(await controller.sampleComb()).toBeUndefined();
    expect(controller.getSnapshot().diagnostic?.message).toBe(describeCode('curvature-degenerate'));
    digest = 'other';
    expect(await controller.sampleComb()).toBeUndefined();
    expect(controller.getSnapshot().diagnostic?.code).toBe('curvature-mismatch');

    // The nodes' curvature, for the shown content; another shape is refused.
    expect(await controller.showCurvature()).toBeUndefined();
    expect(controller.getSnapshot().diagnostic?.code).toBe('curvature-mismatch');
    expect(controller.getSnapshot().curvature).toBeUndefined();
    digest = 'digest';
    let open = () => {};
    gate.hold = new Promise((resolve) => (open = resolve));
    const running = controller.showCurvature();
    expect(controller.getSnapshot().curvature).toEqual({ status: 'running' });
    open();
    expect(await running).toEqual([{ bodyId: 'plate', mean, gauss }]);
    expect(controller.getSnapshot().curvature).toEqual({
      status: 'done',
      bodies: [{ bodyId: 'plate', mean, gauss }],
    });
    expect(cadContentHash(session.content)).toBe(contentHash);
    // Another content: gone, and an answer for the old content while it ran is dropped.
    gate.hold = new Promise((resolve) => (open = resolve));
    const stale = controller.showCurvature();
    await controller.run({ type: 'setParameter', parameterId: 'W', value: 90 });
    expect(controller.getSnapshot().curvature).toBeUndefined();
    open();
    expect(await stale).toBeUndefined();
    expect(controller.getSnapshot().curvature).toBeUndefined();
    // Without the kernel's analyses the Surface cannot offer them.
    const bare = setup(true, true);
    await bare.controller.refresh();
    const hash = bare.controller.getSnapshot().contentHash;
    bare.controller.receiveMeshes(hash, [picked()]);
    bare.controller.select({ kind: 'edge', id: 'plate', pick: 21, contentHash: hash });
    expect(await bare.controller.sampleComb()).toBeUndefined();
    expect(bare.controller.getSnapshot().diagnostic?.code).toBe('kernel-unavailable');
    expect(await bare.controller.showCurvature()).toBeUndefined();
    expect(bare.controller.getSnapshot().diagnostic?.code).toBe('kernel-unavailable');
  });

  /** `picked()` with the +z face as one flat triangle, and the +y face as a bent pair. */
  const shaded = (): CadMesh => {
    const mesh = picked();
    mesh.positions = new Float32Array(18);
    mesh.normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0.8, 0.6]);
    mesh.indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
    mesh.faceIds = new Uint32Array([11, 12]);
    return mesh;
  };
  const ready = async () => {
    const t = setup(true, true);
    await t.controller.refresh();
    const { contentHash } = t.controller.getSnapshot();
    t.controller.receiveMeshes(contentHash, [shaded()]);
    return { ...t, contentHash };
  };
  const added = (session: { content: { features: CadFeature[] } }) =>
    session.content.features.at(-2)!;

  it('reads a planar face normal from its mesh, and none for a curved face', () => {
    const mesh = shaded();
    const at = (pick: number) =>
      topologyInfo([mesh], { kind: 'face', id: 'plate', pick, contentHash: 'h' });
    expect(at(11)?.normal).toEqual([0, 0, 1]);
    expect(at(12)?.normal).toBeUndefined();
  });

  it('fillets or chamfers the picked edge as one edit, recording what tells it apart (R1c)', async () => {
    const { controller, session, contentHash } = await ready();
    controller.select({ kind: 'edge', id: 'plate', pick: 21, contentHash });
    expect(await controller.blendPickedEdge('fillet', 2)).toBe(true);
    const fillet = added(session);
    expect(fillet).toMatchObject({
      type: 'fillet',
      inputFeatureIds: ['plate-cut-placement'],
      args: {
        radius: mm(2),
        edges: [
          {
            kind: 'edge',
            featureId: 'plate-cut-placement',
            name: [['+y'], ['+z']],
            select: { adjacent: [[['+z'], ['tool:s', '-x']]] },
            hint: { centroid: [22.5, 60, 20], size: 45 },
          },
        ],
      },
    });
    expect(session.content.bodies.find((b) => b.id === 'plate')?.resultFeatureId).toBe(
      session.content.features.at(-1)!.id,
    );
    // The new feature is selected for its dimensions; Undo takes the whole edit back.
    expect(controller.getSnapshot().selection).toEqual({ kind: 'feature', id: fillet.id });
    controller.undo();
    expect(session.content.features.some((f) => f.id === fillet.id)).toBe(false);
  });

  it('refuses a pick that cannot be referenced, or that is not on the current shape', async () => {
    const { controller, session, contentHash } = await ready();
    const before = session.content;
    controller.select({ kind: 'face', id: 'plate', pick: 15, contentHash });
    expect(await controller.shellPickedFace(2)).toBe(false);
    expect(controller.getSnapshot().diagnostic?.code).toBe('reference-unnamed');
    controller.select({ kind: 'body', id: 'plate' });
    expect(await controller.blendPickedEdge('chamfer', 1)).toBe(false);
    expect(controller.getSnapshot().diagnostic?.code).toBe('selection-stale');
    expect(session.content).toEqual(before);
  });

  it('shells, drafts and mirrors from the picked face (R1c)', async () => {
    const { controller, session, contentHash } = await ready();
    const top = { kind: 'face' as const, id: 'plate', pick: 11, contentHash };
    controller.select(top);
    expect(await controller.shellPickedFace(1.5)).toBe(true);
    expect(added(session)).toMatchObject({
      type: 'shell',
      args: { openFaces: [{ kind: 'face', name: [['+z']] }], thickness: mm(1.5), side: 'inside' },
    });
    controller.undo();
    controller.select(top);
    expect(await controller.draftFromPickedFace(3)).toBe(true);
    const draft = added(session) as Extract<CadFeature, { type: 'draft' }>;
    // The faces around the neutral one are drafted, pulled into the body.
    expect(draft.args.neutral.name).toEqual([['+z']]);
    expect(draft.args.faces.map((f) => f.name)).toEqual([
      [['+y']],
      [['tool:s', '-x']],
      [['tool:s', '+x']],
    ]);
    expect(draft.args.direction).toEqual([0, 0, -1]);
    expect(draft.args.angle).toEqual({ literalRad: (3 * Math.PI) / 180 });
    controller.undo();
    controller.select(top);
    expect(await controller.mirrorInPickedFace()).toBe(true);
    expect(added(session)).toMatchObject({
      type: 'mirror',
      args: { plane: { face: { name: [['+z']] } }, union: true },
    });
    controller.undo();
    // A curved face has no plane to draft from.
    controller.select({ ...top, pick: 12 });
    expect(await controller.draftFromPickedFace(3)).toBe(false);
    expect(controller.getSnapshot().diagnostic?.code).toBe('draft-neutral-not-planar');
  });

  it('patterns another body into this one as one edit and selects the pattern', async () => {
    const { controller, session } = setup();
    await controller.refresh();
    await controller.run({
      type: 'insertFeatures',
      features: [
        {
          id: 'peg',
          name: 'Peg',
          type: 'cylinder',
          inputFeatureIds: [],
          args: {
            radius: mm(2),
            height: mm(9),
            origin: position(10, 10, -1),
            orientation: identityQuaternion(),
          },
        },
      ],
      bodies: [
        {
          id: 'peg-body',
          name: 'Peg',
          sourceFeatureId: 'peg',
          placementFeatureId: 'peg-placement',
          appearance: { color: '#888888', opacity: 1 },
        },
      ],
    });
    const layout = {
      type: 'linear' as const,
      direction: [1, 0, 0] as [number, number, number],
      count: { literal: 4 },
      spacing: mm(15),
    };
    expect(await controller.pattern('plate', 'peg-body', 'cut', layout)).toBe(true);
    const pattern = added(session);
    expect(pattern).toMatchObject({ type: 'pattern', args: { mode: 'cut', layout } });
    expect(session.content.bodies.find((b) => b.id === 'peg-body')?.state).toBe('consumed');
    expect(controller.getSnapshot().selection).toEqual({ kind: 'feature', id: pattern.id });
  });

  it('collects picked edges for a fill and a loft section, and uses them up (R2a-2c, ST-47)', async () => {
    const { controller, session, contentHash } = await ready();
    for (const pick of [23, 24, 23, 21]) {
      controller.select({ kind: 'edge', id: 'plate', pick, contentHash });
      expect(controller.collectPickedEdge()).toBe(true);
    }
    // In pick order, once each; the shared name records its neighbour as a fillet would.
    const edges = controller.getSnapshot().collectedEdges;
    expect(edges.map((e) => [e.label, e.free])).toEqual([
      ['+z | tool:s/-x (plate)', false],
      ['+z | tool:s/+x (plate)', false],
      ['+y | +z (plate)', false],
    ]);
    expect(edges[2]!.ref).toMatchObject({ featureId: 'plate-cut-placement', select: {} });
    // A solid loft has no edge sections; the content and the collection stay.
    const before = controller.getSnapshot().contentHash;
    expect(await controller.addLoft([{ edges: edges.map((e) => e.ref) }, 'x'], false)).toBe(false);
    expect(controller.getSnapshot().diagnostic?.code).toBe('section-region');
    expect(controller.getSnapshot().contentHash).toBe(before);
    expect(
      await controller.addBoundary(
        'fill',
        edges.map((e, i) => ({ curve: { edge: e.ref }, continuity: i ? 'G0' : 'G1' })),
      ),
    ).toBe(true);
    const fill = session.content.features.find((f) => f.type === 'fill')!;
    expect(fill).toMatchObject({
      name: 'Fill',
      inputFeatureIds: [],
      args: {
        boundary: [
          { curve: { edge: edges[0]!.ref }, continuity: 'G1' },
          { curve: { edge: edges[1]!.ref }, continuity: 'G0' },
          { curve: { edge: edges[2]!.ref }, continuity: 'G0' },
        ],
      },
    });
    expect(session.content.bodies.at(-1)).toMatchObject({ name: 'Surface', kind: 'sheet' });
    expect(controller.getSnapshot().collectedEdges).toEqual([]);
    controller.clearCollectedEdges();
    // One edit: Undo removes the fill and its body.
    await controller.undo();
    expect(session.content.features.some((f) => f.type === 'fill')).toBe(false);
  });

  it('spans a boundary surface through sketch curves in loop order (R2a-2c, ST-47)', async () => {
    const hypar = f17Boundaries('hypar');
    const { controller } = setup(true, false, { ...hypar, features: [], bodies: [] });
    await controller.refresh();
    const curves =
      hypar.features[0]!.type === 'boundarySurface' ? hypar.features[0]!.args.curves : [];
    expect(
      await controller.addBoundary(
        'boundarySurface',
        curves.map((curve) => ({ curve })),
      ),
    ).toBe(true);
    const doc = controller.getSnapshot().content;
    expect(doc.features[0]).toMatchObject({ type: 'boundarySurface', args: { curves } });
    expect(doc.bodies.map((b) => [b.name, b.kind])).toEqual([['Surface', 'sheet']]);
    // Two curves are too few: refused by validation, the content stays.
    const before = controller.getSnapshot().contentHash;
    expect(
      await controller.addBoundary(
        'boundarySurface',
        curves.slice(0, 2).map((curve) => ({ curve })),
      ),
    ).toBe(false);
    expect(controller.getSnapshot().diagnostic?.code).toBe(
      'cad-invalid:boundary-curves@$.features[2].args.curves',
    );
    expect(controller.getSnapshot().contentHash).toBe(before);
  });

  it('sews, trims and thickens sheet bodies, one edit each (R2a-3, ST-48)', async () => {
    const { controller, session, failNext } = setup(true, false, f18Hood('sheets'));
    await controller.refresh();
    const body = (id: string) => session.content.bodies.find((b) => b.id === id)!;
    // A gap names the input edges left apart in the message; the content stays.
    const before = controller.getSnapshot().contentHash;
    failNext('sew-gap', 'sew-1', false, undefined, [
      { featureId: 'crown-placement', name: [['sketch:front', 'boundary:e:aC'], ['surface']] },
    ]);
    expect(await controller.sewBodies('left', ['crown', 'right'], false)).toBe(false);
    expect(controller.getSnapshot().diagnostic).toMatchObject({ code: 'sew-gap' });
    expect(controller.getSnapshot().diagnostic!.message).toContain(
      '離れている辺：sketch:front/boundary:e:aC | surface（crown-placement）',
    );
    expect(controller.getSnapshot().contentHash).toBe(before);
    expect(await controller.sewBodies('left', ['crown', 'right'], false)).toBe(true);
    const sew = session.content.features.find((f) => f.type === 'sew')!;
    expect(sew).toMatchObject({
      inputFeatureIds: ['left-placement', 'crown-placement', 'right-placement'],
      args: { toleranceMm: 0.0001, solid: false },
    });
    expect(controller.getSnapshot().selection).toEqual({ kind: 'feature', id: sew.id });
    expect(['crown', 'right'].map((id) => body(id).state)).toEqual(['consumed', 'consumed']);
    // The window's sketch, then a trim by it keeping the outside, and a thicken: a solid.
    const window = f18Hood('trim').sketches.find((s) => s.id === 'window')!;
    await controller.run({ type: 'insertFeatures', features: [], sketches: [window] });
    const sewn = body('left').resultFeatureId;
    expect(await controller.trimBody(body('left'), { sketchId: 'window' }, 'outside')).toBe(true);
    expect(session.content.features.find((f) => f.type === 'trim')).toMatchObject({
      inputFeatureIds: [sewn],
      args: {
        tool: { sketchId: 'window', elements: ['e0', 'e1', 'e2', 'e3'] },
        keep: 'outside',
      },
    });
    expect(await controller.thickenBody(body('left'), 1.5, 'front')).toBe(true);
    expect(session.content.features.at(-2)).toMatchObject({
      type: 'thicken',
      args: { thickness: { literalMm: 1.5 }, side: 'front' },
    });
    expect(body('left').kind).toBe('solid');
    // Undo takes the thicken back as one edit: a sheet again.
    await controller.undo();
    expect(body('left').kind).toBe('sheet');
    // A plane tool is stored as a point and a normal; a missing body is refused, content kept.
    expect(
      await controller.trimBody(
        body('left'),
        { plane: { origin: [0, 40, 0], normal: [0, 1, 0] } },
        'front',
      ),
    ).toBe(true);
    expect(session.content.features.at(-2)).toMatchObject({
      type: 'trim',
      args: {
        tool: {
          plane: {
            origin: [{ literalMm: 0 }, { literalMm: 40 }, { literalMm: 0 }],
            normal: [0, 1, 0],
          },
        },
        keep: 'front',
      },
    });
    const kept = controller.getSnapshot().contentHash;
    expect(await controller.trimBody(body('left'), { bodyId: 'crown' }, 'front')).toBe(false);
    expect(controller.getSnapshot().diagnostic?.code).toBe('trim-tool');
    expect(controller.getSnapshot().contentHash).toBe(kept);
  });

  it('lists each reference with its state on the current evaluation (CAD31)', async () => {
    const { controller, session, contentHash } = await ready();
    controller.select({ kind: 'edge', id: 'plate', pick: 21, contentHash });
    await controller.blendPickedEdge('fillet', 1);
    const fillet = added(session);
    const snapshot = controller.getSnapshot();
    expect(
      referenceRows(fillet, snapshot.contentHash, snapshot.evaluation).map((r) => r.state),
    ).toEqual(['resolved']);
    // Recalculating: an evaluation of other content confirms nothing.
    expect(referenceRows(fillet, 'other', snapshot.evaluation)[0]!.state).toBe('unknown');
    const broken = {
      status: 'error' as const,
      contentHash: snapshot.contentHash,
      code: 'reference-ambiguous',
      featureId: fillet.id,
      retryable: false,
      references: [
        {
          featureId: fillet.id,
          path: ['edges', 0],
          status: 'ambiguous' as const,
          candidates: [{ hint: { centroid: [0, 0, 0] as [number, number, number], size: 1 } }],
        },
      ],
    };
    expect(referenceRows(fillet, snapshot.contentHash, broken)).toMatchObject([
      { path: ['edges', 0], state: 'ambiguous', candidates: 1 },
    ]);
    const gone = { ...broken.references[0]!, status: 'missing' as const, candidates: [] };
    expect(
      referenceRows(fillet, snapshot.contentHash, { ...broken, references: [gone] }),
    ).toMatchObject([{ state: 'missing', candidates: 0 }]);
    // A shape that failed at another feature says nothing about this one.
    expect(
      referenceRows(fillet, snapshot.contentHash, { ...broken, featureId: 'plate-cut' })[0]!.state,
    ).toBe('unknown');
  });
});

describe('CadController choosing broken references again (R1c, CAD30)', () => {
  const edge = (y: number): CadTopologyRef => ({
    kind: 'edge',
    featureId: 'plate-cut-placement',
    name: [['+y'], ['+z']],
    select: { adjacent: [[['+z'], [`tool:s${y}`, '-x']]] },
    hint: { centroid: [y, 50, 5], size: 20 },
  });
  /** `edge` without its `select`, as a reference to an edge that names alone pick. */
  const plain = (ref: CadTopologyRef): CadTopologyRef => {
    const { select: _, ...rest } = ref;
    return rest;
  };
  const other: CadTopologyRef = {
    kind: 'edge',
    featureId: 'round-placement',
    name: [['+z'], ['-y']],
    hint: { centroid: [40, 0, 5], size: 80 },
  };
  /**
   * F02 with an R1 fillet `round` on the top +y edge and an R1 fillet `round2` after it on the
   * top −y edge.
   */
  const filletedDoc = () => {
    let doc = applyCadOperation(f02Plate(), {
      type: 'detailBody',
      bodyId: 'plate',
      placementFeatureId: 'round-placement',
      feature: {
        id: 'round',
        name: 'Round',
        type: 'fillet',
        inputFeatureIds: ['plate-cut-placement'],
        args: { edges: [plain(edge(40))], radius: mm(1) },
      },
    });
    doc = applyCadOperation(doc, {
      type: 'detailBody',
      bodyId: 'plate',
      placementFeatureId: 'round2-placement',
      feature: {
        id: 'round2',
        name: 'Round 2',
        type: 'fillet',
        inputFeatureIds: ['round-placement'],
        args: { edges: [other], radius: mm(1) },
      },
    });
    return doc;
  };
  const filleted = async ({
    broken = false,
    budget,
  }: { broken?: boolean; budget?: number } = {}) => {
    const t = setup(true, true, filletedDoc(), budget ? { mainBytes: budget } : undefined);
    const split = (candidates: (CadTopologyRef | undefined)[], featureId = 'round') =>
      t.failNext('reference-ambiguous', featureId, false, [
        {
          featureId,
          path: ['edges', 0],
          status: 'ambiguous',
          candidates: candidates.map((ref, i) => ({
            ...(ref ? { ref } : {}),
            hint: ref?.hint ?? { centroid: [i, 0, 0], size: 1 },
          })),
        },
      ]);
    if (broken) split([edge(20), edge(60)]);
    await t.controller.refresh();
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const ref = (doc: { features: CadFeature[] }, id = 'round') =>
      (doc.features.find((f) => f.id === id) as Extract<CadFeature, { type: 'fillet' }>).args
        .edges[0]!;
    return { ...t, split, settle, round: ref, ref };
  };

  it('previews each candidate and applies the edit with the chosen one as one edit', async () => {
    const { controller, session, requests, split, settle, round } = await filleted();
    const before = session.content;
    split([edge(20), edge(60)]);
    expect(await controller.run({ type: 'setParameter', parameterId: 'W', value: 90 })).toBe(false);
    await settle();
    let view = controller.getSnapshot().rebind!;
    expect(view).toMatchObject({
      featureName: 'Round',
      withEdit: true,
      status: 'ready',
      problems: [{ path: ['edges', 0], status: 'ambiguous', choice: 0 }],
    });
    // The preview evaluates the edit with the first candidate; nothing is applied yet.
    expect(round(requests.at(-1)!.document)).toEqual(edge(20));
    expect(session.content).toEqual(before);
    controller.chooseRebind(0, 1);
    await settle();
    view = controller.getSnapshot().rebind!;
    expect(view.problems[0]!.choice).toBe(1);
    expect(round(requests.at(-1)!.document)).toEqual(edge(60));
    // Its meshes are shown as the preview, never picked.
    controller.receiveMeshes(view.previewHash!, []);
    expect(controller.getSnapshot().meshes).toMatchObject({ current: false, preview: true });
    expect(controller.confirmRebind()).toBe(true);
    expect(controller.getSnapshot().rebind).toBeUndefined();
    expect(session.content.parameters.find((p) => p.id === 'W')?.value).toBe(90);
    expect(round(session.content)).toEqual(edge(60));
    // One Undo takes back both the edit and the choice.
    await controller.undo();
    expect(session.content).toEqual(before);
  });

  it('cancels without changing anything; a new edit or Undo also drops the choice', async () => {
    const { controller, session, split, settle } = await filleted();
    const before = session.content;
    split([edge(20), edge(60)]);
    await controller.run({ type: 'setParameter', parameterId: 'W', value: 90 });
    await settle();
    controller.cancelRebind();
    expect(controller.getSnapshot().rebind).toBeUndefined();
    expect(session.content).toEqual(before);
    split([edge(20), edge(60)]);
    await controller.run({ type: 'setParameter', parameterId: 'W', value: 90 });
    await settle();
    // While it waits on Confirm or Cancel, the Host's input boundary holds it as pending work.
    expect(cadInputState(controller)).toEqual({ dirty: true, settles: false });
    const rejections = controller.getSnapshot().rejections;
    await controller.run({ type: 'rename', targetId: 'plate', name: 'Base' });
    expect(controller.getSnapshot().rebind).toBeUndefined();
    expect(controller.confirmRebind()).toBe(false);
    // The dropped edit resets the field that started it.
    expect(controller.getSnapshot().rejections).toBe(rejections + 1);
    expect(cadInputState(controller)).toEqual({ dirty: false, settles: false });
    // So does Undo of an earlier edit.
    split([edge(20), edge(60)]);
    await controller.run({ type: 'setParameter', parameterId: 'W', value: 90 });
    await settle();
    await controller.undo();
    expect(controller.getSnapshot().rebind).toBeUndefined();
    expect(controller.getSnapshot().rejections).toBe(rejections + 2);
  });

  it('marks the candidate of the reference changed last', async () => {
    const { controller, failNext, settle } = await filleted();
    const problem = (featureId: string, i: number) => ({
      featureId,
      path: ['edges', i],
      status: 'ambiguous' as const,
      candidates: [edge(20 + i), edge(60 + i)].map((ref) => ({ ref, hint: ref.hint })),
    });
    failNext('reference-ambiguous', 'round', false, [problem('round', 0), problem('round', 1)]);
    await controller.run({ type: 'setParameter', parameterId: 'W', value: 90 });
    await settle();
    expect(controller.getSnapshot().rebind?.active).toBe(0);
    controller.chooseRebind(1, 1);
    await settle();
    expect(controller.getSnapshot().rebind).toMatchObject({
      active: 1,
      problems: [{ choice: 0 }, { choice: 1 }],
    });
  });

  it('refuses a preview whose meshes are over the memory budget', async () => {
    const { controller, split, settle, delivered } = await filleted({ budget: 1000 });
    split([edge(20), edge(60)]);
    delivered.meshes = [{ ...big(), bodyId: 'plate' }];
    await controller.run({ type: 'setParameter', parameterId: 'W', value: 90 });
    await settle();
    expect(controller.getSnapshot().rebind).toMatchObject({
      status: 'failed',
      message: describeCode('memory-budget'),
    });
    expect(controller.confirmRebind()).toBe(false);
  });

  it('blocks Confirm when a reference has no candidate it could be chosen as', async () => {
    const { controller, session, split, settle, failNext } = await filleted();
    const before = session.content;
    split([undefined, undefined]);
    await controller.run({ type: 'setParameter', parameterId: 'W', value: 90 });
    await settle();
    expect(controller.getSnapshot().rebind).toMatchObject({
      status: 'blocked',
      problems: [{ choice: -1, candidates: [{ selectable: false }, { selectable: false }] }],
    });
    expect(controller.confirmRebind()).toBe(false);
    controller.cancelRebind();
    failNext('reference-missing', 'round', false, [
      { featureId: 'round', path: ['edges', 0], status: 'missing', candidates: [] },
    ]);
    await controller.run({ type: 'setParameter', parameterId: 'W', value: 90 });
    await settle();
    expect(controller.getSnapshot().rebind).toMatchObject({
      status: 'blocked',
      problems: [{ status: 'missing', choice: -1 }],
    });
    expect(controller.getSnapshot().rebind?.message).toBe(describeCode('rebind-blocked'));
    expect(session.content).toEqual(before);
  });

  it('chooses a later feature’s references in turn when a choice breaks them', async () => {
    const { controller, session, requests, split, settle, ref } = await filleted();
    const moved = {
      ...other,
      hint: { ...other.hint, centroid: [45, 0, 5] as [number, number, number] },
    };
    split([edge(20), edge(60)]);
    // The preview of the first choice fails on the same feature: the panel says why.
    split([edge(70)]);
    await controller.run({ type: 'setParameter', parameterId: 'W', value: 90 });
    await settle();
    expect(controller.getSnapshot().rebind).toMatchObject({ status: 'failed' });
    expect(controller.getSnapshot().rebind?.message).toBe(describeCode('reference-ambiguous'));
    // Another choice breaks the next fillet: its reference is chosen next, keeping the first.
    split([moved, other], 'round2');
    controller.chooseRebind(0, 1);
    await settle();
    expect(controller.getSnapshot().rebind).toMatchObject({
      featureName: 'Round 2',
      status: 'ready',
      canGoBack: true,
    });
    // The first feature's choice can still be changed: back, then forward again.
    controller.backRebind();
    await settle();
    expect(controller.getSnapshot().rebind).toMatchObject({
      featureName: 'Round',
      canGoBack: false,
      problems: [{ choice: 1 }],
    });
    split([moved, other], 'round2');
    controller.chooseRebind(0, 1);
    await settle();
    expect(controller.getSnapshot().rebind).toMatchObject({ featureName: 'Round 2' });
    const last = requests.at(-1)!.document;
    expect([ref(last), ref(last, 'round2')]).toEqual([edge(60), moved]);
    expect(controller.confirmRebind()).toBe(true);
    expect([ref(session.content), ref(session.content, 'round2')]).toEqual([edge(60), moved]);
    expect(session.content.parameters.find((p) => p.id === 'W')?.value).toBe(90);
  });

  it('chooses references of the current content when it cannot be calculated', async () => {
    const { controller, session, settle, round } = await filleted({ broken: true });
    expect(controller.getSnapshot().canRebindCurrent).toBe(true);
    controller.rebindCurrent();
    await settle();
    expect(controller.getSnapshot().rebind).toMatchObject({ withEdit: false, status: 'ready' });
    expect(controller.getSnapshot().canRebindCurrent).toBe(false);
    expect(controller.confirmRebind()).toBe(true);
    expect(round(session.content)).toEqual(edge(20));
    expect(session.content.parameters.find((p) => p.id === 'W')?.value).toBe(80);
  });
});

describe('CadController Sketch mode (R1d-3, CAD34)', () => {
  /** A 40×20 rectangle from the origin: points p1..p4, lines l1..l4 (unconstrained, dof 8). */
  const rectangle = (controller: CadController) => {
    controller.sketchLine({ at: [0, 0] }, { at: [40, 0] });
    controller.sketchLine({ id: 'p2' }, { at: [40, 20] });
    controller.sketchLine({ id: 'p3' }, { at: [0, 20] });
    controller.sketchLine({ id: 'p4' }, { id: 'p1' });
  };
  const fully = (controller: CadController) => {
    for (const line of ['l1', 'l3'])
      controller.sketchConstrain({ type: 'horizontal', line } as never);
    for (const line of ['l2', 'l4'])
      controller.sketchConstrain({ type: 'vertical', line } as never);
    controller.sketchConstrain({ type: 'fix', point: 'p1', at: [mm(0), mm(0)] } as never);
    controller.sketchConstrain({
      type: 'horizontalDistance',
      a: 'p1',
      b: 'p2',
      value: mm(40),
    } as never);
    controller.sketchConstrain({
      type: 'verticalDistance',
      a: 'p2',
      b: 'p3',
      value: mm(20),
    } as never);
  };

  it('draws, constrains to dof 0 and finishes and extrudes as one edit (ST-41#1)', async () => {
    const { controller, session } = setup();
    await controller.refresh();
    const before = controller.getSnapshot().content;
    const hash = controller.getSnapshot().contentHash;
    expect(controller.startSketch('xy')).toBe(true);
    rectangle(controller);
    expect(controller.getSnapshot().sketch).toMatchObject({ dof: 8, isNew: true });
    expect(controller.getSnapshot().sketch?.region).toEqual({
      outer: ['l1', 'l2', 'l3', 'l4'],
      holes: [],
    });
    fully(controller);
    expect(controller.getSnapshot().sketch?.dof).toBe(0);
    // Nothing is an edit while drawing.
    expect(controller.getSnapshot().contentHash).toBe(hash);
    expect(controller.getSnapshot().canUndo).toBe(false);
    expect(await controller.finishSketch({ distance: 10 })).toBe(true);
    const after = controller.getSnapshot();
    expect(after.sketch).toBeUndefined();
    expect(after.content.sketches.map((x) => x.name)).toEqual(['Sketch 1']);
    expect(after.content.sketches[0]!.solved.p3).toEqual([40, 20]);
    expect(after.content.features.find((f) => f.id === 'extrude-2')).toMatchObject({
      type: 'extrude',
      args: { sketchId: after.content.sketches[0]!.id, distance: mm(10) },
    });
    expect(after.content.bodies).toHaveLength(before.bodies.length + 1);
    await controller.undo();
    expect(controller.getSnapshot().content.sketches).toEqual([]);
    expect(session.canUndo).toBe(false);
  });

  it('refuses a conflicting or redundant constraint and names it (ST-41#2)', async () => {
    const { controller } = setup();
    await controller.refresh();
    controller.startSketch('xz');
    rectangle(controller);
    fully(controller);
    const drawing = controller.getSnapshot().sketch!.sketch;
    expect(
      controller.sketchConstrain({ type: 'distance', a: 'p1', b: 'p2', value: mm(50) } as never),
    ).toBe(false);
    const view = controller.getSnapshot().sketch!;
    expect(view.problem).toMatchObject({ code: 'sketch-conflicting-constraint' });
    expect(view.problem!.elements).toEqual(expect.arrayContaining(['p1', 'p2']));
    expect(view.sketch).toBe(drawing);
    expect(controller.sketchConstrain({ type: 'horizontal', line: 'l1' } as never)).toBe(false);
    expect(controller.getSnapshot().sketch!.problem?.code).toBe('sketch-redundant-constraint');
    // A change the solver takes clears the problem.
    expect(controller.sketchDimension('k7', { parameterId: 'nope' })).toBe(false);
    expect(controller.sketchDimension('k7', mm(25))).toBe(true);
    expect(controller.getSnapshot().sketch!.problem).toBeUndefined();
    expect(controller.getSnapshot().sketch!.sketch.solved.p3![1]).toBeCloseTo(25, 6);
  });

  it('removes an element with the constraints on it (dof back up)', async () => {
    const { controller } = setup();
    await controller.refresh();
    controller.startSketch('xy');
    rectangle(controller);
    fully(controller);
    controller.sketchRemove('l3');
    const view = controller.getSnapshot().sketch!;
    expect(view.sketch.constraints.map((k) => k.id)).not.toContain('k2');
    expect(view.region).toBeUndefined();
    expect(view.dof).toBeGreaterThan(0);
    expect(await controller.finishSketch({ distance: 5 })).toBe(false);
    expect(controller.getSnapshot().diagnostic?.code).toBe('sketch-no-region');
    expect(controller.getSnapshot().sketch).toBeDefined();
  });

  it('leaves without an edit, and blocks other edits while open (ST-41#3)', async () => {
    const { controller, session } = setup();
    await controller.refresh();
    const before = controller.getSnapshot().contentHash;
    controller.startSketch('yz');
    rectangle(controller);
    expect(controller.getSnapshot().canSketch).toBe(false);
    expect(await controller.addParameter('length')).toBeFalsy();
    expect(controller.getSnapshot().diagnostic?.code).toBe('sketch-open');
    controller.cancelSketch();
    expect(controller.getSnapshot().sketch).toBeUndefined();
    expect(controller.getSnapshot().contentHash).toBe(before);
    expect(session.canUndo).toBe(false);
  });

  it('keeps an open sketch dirty for the binding, and snaps an arc end to a point', async () => {
    const { controller } = setup();
    await controller.refresh();
    controller.startSketch('xy');
    expect(cadInputState(controller)).toEqual({ dirty: true, settles: false });
    controller.sketchLine({ at: [10, 0] }, { at: [0, 10] });
    controller.sketchArc({ at: [0, 0] }, { id: 'p1' }, { id: 'p2' }, false);
    const arc = controller.getSnapshot().sketch!.sketch.entities.find((e) => e.type === 'arc');
    expect(arc).toMatchObject({ start: 'p1', end: 'p2' });
    controller.cancelSketch();
    expect(cadInputState(controller).dirty).toBe(false);
  });

  it('draws splines: closed alone or open with a line, refusing a crossing one (R2a-2, CAD40)', async () => {
    const { controller } = setup();
    await controller.refresh();
    const before = controller.getSnapshot().content.bodies.length;
    controller.startSketch('xy');
    const ring = controller.sketchSpline(
      [{ at: [0, 0] }, { at: [40, 0] }, { at: [40, 30] }, { at: [0, 30] }],
      true,
    );
    expect(ring).toBe('sp1');
    expect(controller.getSnapshot().sketch!.sketch.entities.at(-1)).toMatchObject({
      type: 'spline',
      poles: ['p1', 'p2', 'p3', 'p4'],
      degree: 3,
      closed: true,
    });
    expect(controller.getSnapshot().sketch?.region).toEqual({ outer: ['sp1'], holes: [] });
    // Control points that make the curve cross itself are refused at once, the drawing kept.
    const drawing = controller.getSnapshot().sketch!.sketch;
    expect(
      controller.sketchSpline(
        [{ at: [100, 0] }, { at: [220, 0] }, { at: [220, 60] }, { at: [60, 60] }, { at: [140, 0] }],
        false,
      ),
    ).toBeUndefined();
    expect(controller.getSnapshot().sketch!.problem?.code).toBe('sketch-self-intersection');
    expect(controller.getSnapshot().sketch!.sketch).toBe(drawing);
    // Too few control points for the degree, or too many, are refused the same way.
    const three: { at: [number, number] }[] = [{ at: [0, 60] }, { at: [40, 60] }, { at: [40, 90] }];
    expect(controller.sketchSpline(three, false, 2)).toBeUndefined();
    expect(controller.getSnapshot().sketch!.problem?.code).toBe('sketch-spline-poles');
    const many = Array.from({ length: 257 }, (_, i) => ({
      at: [i, 200 + (i % 2)] as [number, number],
    }));
    expect(controller.sketchSpline(many, false)).toBeUndefined();
    expect(controller.getSnapshot().sketch!.problem?.code).toBe('sketch-spline-poles');
    expect(controller.getSnapshot().sketch!.sketch).toBe(drawing);
    // Dragging a control point reshapes the curve; the region follows.
    expect(controller.sketchMove('p3', [50, 40])).toBe(true);
    expect(await controller.finishSketch({ distance: 5 })).toBe(true);
    const after = controller.getSnapshot();
    expect(after.content.bodies).toHaveLength(before + 1);
    expect(after.content.sketches[0]!.solved.p3).toEqual([50, 40]);
    expect(after.diagnostic).toBeUndefined();
  });

  it('never reuses a removed ID, and refuses a degenerate stroke at once', async () => {
    const { controller } = setup();
    await controller.refresh();
    controller.startSketch('xy');
    expect(controller.sketchLine({ at: [0, 0] }, { at: [10, 0] })).toBe('l1');
    controller.sketchRemove('l1');
    expect(controller.sketchLine({ at: [0, 0] }, { at: [10, 0] })).toBe('l2');
    expect(controller.sketchLine({ id: 'p3' }, { id: 'p3' })).toBeUndefined();
    expect(controller.getSnapshot().sketch!.problem?.code).toBe('sketch-degenerate');
    expect(controller.sketchCircle({ at: [5, 5] }, 0)).toBeUndefined();
    expect(controller.getSnapshot().sketch!.sketch.entities.map((e) => e.id)).toEqual([
      'p3',
      'p4',
      'l2',
    ]);
  });

  it('opens a stored sketch the solver refuses, and refuses a dimension out of range', async () => {
    const doc = f11Bracket();
    // Satisfied but redundant: validation accepts it, the solver names it.
    doc.sketches[0]!.constraints.push({ id: 'again', type: 'horizontal', line: 'l0' });
    const { controller } = setup(true, false, doc);
    await controller.refresh();
    expect(controller.editSketch('bracket-sketch')).toBe(true);
    expect(controller.getSnapshot().sketch!.problem?.code).toBe('sketch-redundant-constraint');
    expect(controller.sketchRemove('again')).toBe(true);
    expect(controller.getSnapshot().sketch).toMatchObject({ dof: 0, problem: undefined });
    controller.cancelSketch();
    controller.startSketch('xy');
    controller.sketchLine({ at: [0, 0] }, { at: [40, 0] });
    expect(
      controller.sketchConstrain({
        type: 'verticalDistance',
        a: 'p1',
        b: 'p2',
        value: mm(0),
      } as never),
    ).toBe(false);
    expect(controller.getSnapshot().sketch!.problem?.code).toBe('sketch-dimension-range');
  });

  it('refuses Sketch mode without edit authority (ST-41#4)', async () => {
    const { controller } = setup(false);
    await controller.refresh();
    expect(controller.getSnapshot().canSketch).toBe(false);
    expect(controller.startSketch('xy')).toBeFalsy();
    expect(controller.getSnapshot().sketch).toBeUndefined();
    expect(controller.getSnapshot().diagnostic?.code).toBe('sketch-unavailable');
  });

  it('edits an existing sketch as one updateSketch edit (ST-41#5)', async () => {
    const { controller, session } = setup(true, false, f11Bracket());
    await controller.refresh();
    expect(controller.editSketch('bracket-sketch')).toBe(true);
    expect(controller.getSnapshot().sketch).toMatchObject({ dof: 0, isNew: false });
    expect(controller.sketchDimension('blend-r', mm(12))).toBe(true);
    expect(await controller.finishSketch()).toBe(true);
    const sketch = controller.getSnapshot().content.sketches[0]!;
    expect(sketch.constraints.find((k) => k.id === 'blend-r')).toMatchObject({ value: mm(12) });
    expect(controller.getSnapshot().content.features).toEqual(f11Bracket().features);
    await controller.undo();
    expect(
      controller.getSnapshot().content.sketches[0]!.constraints.find((k) => k.id === 'blend-r'),
    ).toMatchObject({ value: mm(10) });
    expect(session.canUndo).toBe(false);
  });
});

describe('CadController loft and sweep (R1e, CAD35)', () => {
  /** The F15 sketches without their features. */
  const sections = (): CadDocument => ({
    ...f15Loft(),
    features: [],
    bodies: [],
    sketches: [...f15Loft().sketches, ...f15Sweep().sketches],
  });

  it('lofts the regions of sketches in order as one edit', async () => {
    const { controller, session } = setup(true, false, sections());
    await controller.refresh();
    expect(await controller.addLoft(['loft-top', 'loft-base'], true)).toBe(true);
    const doc = controller.getSnapshot().content;
    expect(doc.features.find((f) => f.type === 'loft')!.args).toEqual({
      sections: [
        { sketchId: 'loft-top', region: { outer: ['c0'], holes: [] } },
        { sketchId: 'loft-base', region: { outer: ['l0', 'l1', 'l2', 'l3'], holes: [] } },
      ],
      ruled: true,
    });
    expect(doc.bodies.map((b) => b.name)).toEqual(['Loft']);
    expect(controller.getSnapshot().selection).toMatchObject({ kind: 'feature' });
    await controller.undo();
    expect(controller.getSnapshot().content.features).toEqual([]);
    expect(session.canUndo).toBe(false);
  });

  it('lofts a sketch section to sections derived from it (K6, CM-7a)', async () => {
    const { controller } = setup(true, false, sections());
    await controller.refresh();
    expect(
      await controller.addLoft(['loft-base', { derivedFrom: 0, offsetMm: 30, scale: 0.5 }], false),
    ).toBe(true);
    expect(controller.getSnapshot().content.features[0]!.args).toEqual({
      sections: [
        { sketchId: 'loft-base', region: { outer: ['l0', 'l1', 'l2', 'l3'], holes: [] } },
        {
          derivedFrom: 0,
          offset: [{ literalMm: 0 }, { literalMm: 0 }, { literalMm: 30 }],
          scale: { literal: 0.5 },
          angle: { literalRad: 0 },
        },
      ],
      ruled: false,
    });
    // A scale out of range is refused by validation, the content unchanged; a surface loft
    // takes no derived section.
    const before = controller.getSnapshot().contentHash;
    expect(
      await controller.addLoft(['loft-top', { derivedFrom: 0, offsetMm: 30, scale: 0 }], false),
    ).toBe(false);
    expect(controller.getSnapshot().diagnostic?.code).toMatch(/derived-section-scale/);
    expect(
      await controller.addLoft(
        ['loft-top', { derivedFrom: 0, offsetMm: 30, scale: 1 }],
        false,
        true,
      ),
    ).toBe(false);
    expect(controller.getSnapshot().contentHash).toBe(before);
  });

  it('patterns a body along the chain a sketch draws, and refuses a sketch without one (K5a, CM-7b)', async () => {
    const bars = k5aBars();
    const [path, plate, bar] = [bars.sketches[0]!.id, bars.bodies[0]!.id, bars.bodies[1]!.id];
    const doc = { ...bars, sketches: [...bars.sketches, ...f15Loft().sketches] };
    const { controller, session } = setup(true, false, doc);
    await controller.refresh();
    const before = controller.getSnapshot().contentHash;
    // A sketch that draws a closed square makes no open chain.
    const square = {
      type: 'curve' as const,
      sketchId: 'loft-base',
      count: { literal: 3 },
      align: true,
    };
    expect(await controller.pattern(plate, bar, 'union', square)).toBe(false);
    expect(controller.getSnapshot().diagnostic?.code).toBe('sweep-path');
    expect(controller.getSnapshot().contentHash).toBe(before);
    expect(
      await controller.pattern(plate, bar, 'union', { ...square, sketchId: path, align: false }),
    ).toBe(true);
    const pattern = session.content.features.find((f) => f.type === 'pattern')!;
    expect(pattern.args).toEqual({
      mode: 'union',
      layout: {
        type: 'curve',
        path: { sketchId: path, elements: ['l', 'a'] },
        count: { literal: 3 },
        align: false,
      },
    });
    expect(controller.getSnapshot().selection).toEqual({ kind: 'feature', id: pattern.id });
  });

  it('sweeps a region along the chain a sketch draws, and refuses a sketch without one', async () => {
    const { controller } = setup(true, false, sections());
    await controller.refresh();
    // The profile draws no open chain; the path closes no region.
    expect(await controller.addSweep('pipe-path', 'pipe-profile', 'frenet')).toBe(false);
    expect(controller.getSnapshot().diagnostic?.code).toBe('section-region');
    expect(await controller.addSweep('pipe-profile', 'loft-base', 'frenet')).toBe(false);
    expect(controller.getSnapshot().diagnostic?.code).toBe('sweep-path');
    expect(await controller.addSweep('pipe-profile', 'pipe-path', 'fixed')).toBe(true);
    expect(controller.getSnapshot().content.features[0]!.args).toEqual({
      profile: { sketchId: 'pipe-profile', region: { outer: ['c0'], holes: [] } },
      path: { sketchId: 'pipe-path', elements: ['l0', 'a0'] },
      orientation: 'fixed',
    });
    // A loft of one sketch's two regions is refused by validation, the content unchanged.
    const before = controller.getSnapshot().contentHash;
    expect(await controller.addLoft(['loft-base', 'loft-base'], false)).toBe(false);
    expect(controller.getSnapshot().diagnostic?.code).toMatch(/loft-same-sketch/);
    expect(controller.getSnapshot().contentHash).toBe(before);
  });

  it('lofts and sweeps the chains sketches draw into surfaces (R2a-2b, CAD41)', async () => {
    const chains = (): CadDocument => ({
      ...f17Surfaces('closed'),
      features: [],
      bodies: [],
      sketches: [...f17Surfaces('closed').sketches, ...f17Surfaces('sweep').sketches],
    });
    const { controller, session } = setup(true, false, chains());
    await controller.refresh();
    expect(await controller.addLoft(['a', 'b'], true, true)).toBe(true);
    let doc = controller.getSnapshot().content;
    expect(doc.features[0]).toMatchObject({
      type: 'surfaceLoft',
      args: {
        sections: [
          { sketchId: 'a', elements: ['a-l0', 'a-l1', 'a-l2', 'a-l3'] },
          { sketchId: 'b', elements: ['b-l0', 'b-l1', 'b-l2', 'b-l3'] },
        ],
        ruled: true,
      },
    });
    expect(doc.bodies.map((b) => [b.name, b.kind])).toEqual([['Surface', 'sheet']]);
    expect(await controller.addSweep('profile', 'rail', 'frenet', true)).toBe(true);
    doc = controller.getSnapshot().content;
    expect(doc.features.find((f) => f.type === 'surfaceSweep')!.args).toEqual({
      profile: { sketchId: 'profile', elements: ['l0', 'l1'] },
      path: { sketchId: 'rail', elements: ['turn'] },
      orientation: 'frenet',
    });
    // A path that draws a loop is no sweep path; the content stays.
    const before = controller.getSnapshot().contentHash;
    expect(await controller.addSweep('profile', 'a', 'frenet', true)).toBe(false);
    expect(controller.getSnapshot().diagnostic?.code).toBe('sweep-path');
    expect(controller.getSnapshot().contentHash).toBe(before);
    await controller.undo();
    await controller.undo();
    expect(controller.getSnapshot().content.features).toEqual([]);
    expect(session.canUndo).toBe(false);
  });
});

describe('a long evaluation (CM-4, P3)', () => {
  /** A kernel that answers only when told: a cancel answers `cancelled`, as the Worker port does. */
  function held({ late = false } = {}) {
    const pending = new Map<string, (e: CadEvaluation) => void>();
    const cancelled: string[] = [];
    const requests: CadEvaluateRequest[] = [];
    const kernel: CadKernelPort = {
      evaluate: (request) =>
        new Promise((resolve) => {
          requests.push(request);
          pending.set(request.requestId, resolve);
        }),
      cancel: (id) => {
        cancelled.push(id);
        // `late`: the Worker had already answered, so the answer comes instead of `cancelled`.
        if (late) return;
        pending.get(id)?.({
          status: 'error',
          contentHash: requests.find((r) => r.requestId === id)!.candidateHash,
          code: 'cancelled',
          retryable: true,
        });
        pending.delete(id);
      },
    };
    const ok = (r: CadEvaluateRequest): CadEvaluation => ({
      status: 'ok',
      contentHash: r.candidateHash,
      buildHash: fixtureKernel.buildHash,
      geometryDigest: 'd',
      bodies: {},
    });
    const answer = (r: CadEvaluateRequest) => {
      pending.get(r.requestId)?.(ok(r));
      pending.delete(r.requestId);
    };
    const session = new EditorSession(f02Plate());
    const controller = new CadController({
      session,
      kernel,
      canEdit: () => true,
      permissionGeneration: () => 1,
    });
    return { controller, session, requests, cancelled, answer };
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('shows how far an edit got, and Stop leaves the content and history as they were', async () => {
    const { controller, session, requests, cancelled, answer } = held();
    void controller.refresh();
    await flush();
    answer(requests[0]!);
    await flush();
    expect(controller.getSnapshot()).toMatchObject({ canStop: false, progress: undefined });
    const before = cadContentHash(session.content);
    const edit = controller.run({ type: 'setParameter', parameterId: 'W', value: 100 });
    await flush();
    expect(controller.getSnapshot().canStop).toBe(true);
    controller.receiveProgress(12, 40);
    expect(controller.getSnapshot().progress).toEqual({ done: 12, total: 40 });
    controller.stopEvaluation();
    expect(await edit).toBe(false);
    expect(cancelled).toEqual([requests[1]!.requestId]);
    expect(cadContentHash(session.content)).toBe(before);
    expect(session.canUndo).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      busy: false,
      canStop: false,
      progress: undefined,
      geometryState: 'ready',
      diagnostic: { code: 'cancelled' },
    });
    // A progress report after the stop is not shown.
    controller.receiveProgress(13, 40);
    expect(controller.getSnapshot().progress).toBeUndefined();
  });

  it('Stop on the open document reports it as cancelled until Recalculate', async () => {
    const { controller, requests, cancelled, answer } = held();
    void controller.refresh();
    await flush();
    expect(controller.getSnapshot()).toMatchObject({
      geometryState: 'reevaluating',
      canStop: true,
    });
    controller.receiveProgress(3, 9);
    controller.stopEvaluation();
    await flush();
    expect(cancelled).toEqual([requests[0]!.requestId]);
    expect(controller.getSnapshot()).toMatchObject({
      geometryState: 'geometry-error',
      canStop: false,
      progress: undefined,
    });
    void controller.refresh({ retry: true });
    await flush();
    answer(requests[1]!);
    await flush();
    expect(controller.getSnapshot().geometryState).toBe('ready');
  });

  it('a previewed edit can be stopped too, and leaves nothing prepared', async () => {
    const { controller, requests, cancelled, answer } = held();
    void controller.refresh();
    await flush();
    answer(requests[0]!);
    await flush();
    const preview = controller.prepareEdit({ type: 'setParameter', parameterId: 'W', value: 90 });
    await flush();
    expect(controller.getSnapshot().canStop).toBe(true);
    controller.receiveProgress(2, 5);
    expect(controller.getSnapshot().progress).toEqual({ done: 2, total: 5 });
    controller.stopEvaluation();
    expect(await preview).toBeUndefined();
    expect(cancelled).toEqual([requests[1]!.requestId]);
    expect(controller.editPrepared).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      busy: false,
      canStop: false,
      diagnostic: { code: 'cancelled' },
    });
  });

  it('a result already on its way when Stop is pressed does not replace the stop', async () => {
    const { controller, requests, answer } = held({ late: true });
    void controller.refresh();
    await flush();
    // The Worker had answered: the cancel no longer reaches it, and its result arrives late.
    const late = requests[0]!;
    controller.stopEvaluation();
    answer(late);
    await flush();
    expect(controller.getSnapshot()).toMatchObject({
      geometryState: 'geometry-error',
      geometryFailure: expect.stringContaining('取り消し'),
    });
  });
});
