import { EditorSession } from '@editor-platform/editor-core';
import { describe, expect, it } from 'vitest';
import {
  f02Plate,
  fixtureKernel,
  type CadEvaluateRequest,
  type CadEvaluation,
  type CadKernelPort,
} from '@editor-platform/cad-core';
import { CadController, describeCode } from './controller';

/**
 * Kernel that answers immediately; `fail` turns the next answer into a geometry error. With
 * `meshes`, every successful evaluation also delivers an (empty) mesh like the Worker port does.
 */
function setup(canEdit = true, meshes = false) {
  const auth = { canEdit };
  let fail: string | undefined;
  const requests: CadEvaluateRequest[] = [];
  const kernel: CadKernelPort = {
    evaluate: async (request) => {
      requests.push(request);
      const code = fail;
      fail = undefined;
      if (!code && meshes) controller.receiveMeshes(request.candidateHash, []);
      return (
        code
          ? { status: 'error', contentHash: request.candidateHash, code, retryable: false }
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
  const session = new EditorSession(f02Plate());
  const controller = new CadController({
    session,
    kernel,
    canEdit: () => auth.canEdit,
    permissionGeneration: () => 1,
    newId: (prefix) => `${prefix}-${++n}`,
  });
  return { controller, session, auth, requests, failNext: (code: string) => (fail = code) };
}

describe('CadController', () => {
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
