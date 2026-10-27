import { EditorSession } from '@editor-platform/editor-core';
import { describe, expect, it } from 'vitest';
import {
  CadAssemblyPort,
  connectorRefKey,
  mm,
  r2bJoints,
  type CadEvaluateRequest,
  type CadEvaluation,
  type CadPartKernelPort,
} from '@editor-platform/cad-core';
import { CadAssembly } from './assembly';
import { CadController } from './controller';
import { editedJointValues, jointFields, limitText, validJointFields } from './joint-values';

/** F20 in a controller over a kernel double that answers the fixture's analytic frames. */
function setup(change?: (f: ReturnType<typeof r2bJoints>) => void) {
  const f = r2bJoints();
  change?.(f);
  const answer = (request: CadEvaluateRequest, at: string): CadEvaluation => ({
    status: 'ok',
    contentHash: request.candidateHash,
    buildHash: request.document.kernelProfile.buildHash,
    geometryDigest: 'd',
    bodies: {},
    ...(request.connectors
      ? {
          connectors: request.connectors.map(
            (r) =>
              f.frames.get(`${at} ${connectorRefKey(r)}`) ?? { status: 'missing', candidates: [] },
          ),
        }
      : {}),
  });
  const kernel: CadPartKernelPort = {
    evaluate: async (r) => answer(r, 'own'),
    // Part meshes reach the parts, as the binding routes them (none are drawn here).
    evaluatePart: async (r) => (assembly.receive(r.candidateHash, []), answer(r, r.candidateHash)),
    cancel: () => {},
  };
  const store = { get: (h: string) => f.closure.get(h), stage: async () => {} };
  const port = new CadAssemblyPort({ kernel, parts: store.get });
  const session = new EditorSession(f.assembly);
  const controller = new CadController({
    session,
    kernel: port,
    canEdit: () => true,
    permissionGeneration: () => 0,
  });
  const assembly: CadAssembly = new CadAssembly({ controller, port, store });
  return { f, session, controller, assembly };
}
const z = (c: CadController, id: string) =>
  +c.getSnapshot().content.solvedPoses[id]!.translationMm[2].toFixed(9);

describe('joints in the Surface (R2b-2, CAD47)', () => {
  it('shows a joint value in its unit and keeps an untouched one exactly', () => {
    const { assembly: doc } = r2bJoints();
    const turn = doc.joints.find((j) => j.id === 'j-turn')!;
    expect(jointFields(turn, doc)).toEqual(['30']);
    expect(limitText(turn, 'angle')).toBe('-180 – 180');
    // The angle reads parameter A: left as shown it stays bound.
    expect(editedJointValues(turn, ['30'], ['30'])).toEqual({ angle: { parameterId: 'A' } });
    const plane = doc.joints.find((j) => j.id === 'j-plane')!;
    expect(jointFields(plane, doc)).toEqual(['-120', '10', '90']);
    expect(editedJointValues(plane, ['-120', '10', '90'], ['-120', '12.5', '90'])).toEqual({
      u: mm(-120),
      v: mm(12.5),
      angle: { literalRad: Math.PI / 2 },
    });
    expect(validJointFields(plane, ['1', '', '2'])).toBe(false);
  });

  it('applies a joint value entry as one edit, keeps it across selection, drops it under Undo', async () => {
    const { controller, assembly, session } = setup();
    await controller.refresh();
    assembly.selectJoint('j-slide');
    expect(assembly.getSnapshot().selectedJoint).toBe('j-slide');
    assembly.setJointDraft('j-slide', { fields: ['15'], shown: ['12'] });
    // Selecting a component keeps the entry; the joint selection goes.
    assembly.select('c-shaft');
    expect(assembly.getSnapshot().selectedJoint).toBeUndefined();
    expect(assembly.getSnapshot().jointDrafts.get('j-slide')?.fields).toEqual(['15']);
    expect(await assembly.applyJointDraft('j-slide')).toBe(true);
    expect(assembly.getSnapshot().jointDrafts.size).toBe(0);
    expect(z(controller, 'c-plate-2')).toBe(20);
    expect(z(controller, 'c-plate-3')).toBe(25);
    // A refused value (past the 20 mm limit) is not kept and moves nothing.
    assembly.setJointDraft('j-slide', { fields: ['25'], shown: ['15'] });
    expect(await assembly.applyJointDraft('j-slide')).toBe(false);
    expect(z(controller, 'c-plate-2')).toBe(20);
    // Undo changes the shown value under an entry: the entry goes with it.
    assembly.setJointDraft('j-slide', { fields: ['3'], shown: ['15'] });
    session.undo();
    await controller.sync();
    expect(assembly.getSnapshot().jointDrafts.size).toBe(0);
    expect(z(controller, 'c-plate-2')).toBe(17);
  });

  it('keeps a typed value through a click on the child, and refuses a drag whose content changed', async () => {
    const { controller, assembly } = setup();
    await controller.refresh();
    assembly.selectJoint('j-slide');
    assembly.setJointDraft('j-slide', { fields: ['15'], shown: ['12'] });
    const e = controller.getSnapshot().evaluation;
    const solved = e?.status === 'ok' ? e.assembly!.joints!['j-slide'] : undefined;
    if (solved?.status !== 'solved') throw new Error('j-slide is not solved');
    const at = solved.parent.translationMm;
    // A level ray across the slider's axis (the world's z): its height is the distance.
    const level = (dz: number) => ({
      origin: [at[0]! - 100, at[1]!, at[2]! + dz] as [number, number, number],
      direction: [1, 0, 0] as [number, number, number],
    });
    const tool = assembly.jointDragTool()!;
    expect(tool.moves.has('c-plate-2')).toBe(true);
    // Pressed and released without moving: no edit, and the typed 15 stays.
    expect(tool.start(level(0), [at[0]!, at[1]!, at[2]!], false)).toBeUndefined();
    expect(await tool.end(false)).toBe(false);
    expect(assembly.getSnapshot().jointDrafts.get('j-slide')?.fields).toEqual(['15']);
    // Undo (here another edit) during a drag: its release writes nothing.
    expect(tool.start(level(0), [at[0]!, at[1]!, at[2]!], false)).toBeUndefined();
    expect(tool.move(level(3))).toBeDefined();
    expect(assembly.getSnapshot().dragging).toMatchObject({ values: { distance: 15 } });
    expect(
      await controller.run({
        type: 'setJointValues',
        jointId: 'j-slide',
        values: { distance: mm(5) },
      }),
    ).toBe(true);
    expect(await tool.end(true)).toBe(false);
    expect(controller.getSnapshot().diagnostic?.message).toContain(
      '動かしている間に内容が変わりました',
    );
    expect(z(controller, 'c-plate-2')).toBe(10);
    // The tool kept from before the edit does not start again; a new one does.
    expect(tool.start(level(0), [at[0]!, at[1]!, at[2]!], false)).toBe('joint-drag-changed');
    const next = assembly.jointDragTool()!;
    assembly.setJointDraft('j-slide', { fields: ['7'], shown: ['5'] });
    expect(next.start(level(0), [at[0]!, at[1]!, at[2]!], false)).toBeUndefined();
    next.move(level(2));
    expect(await next.end(true)).toBe(true);
    expect(z(controller, 'c-plate-2')).toBe(12);
    // The drag that moved replaces the typed value.
    expect(assembly.getSnapshot().jointDrafts.size).toBe(0);
  });

  it('adopts solved poses only by the explicit action, and deletes a joint fixing its child', async () => {
    const { controller, assembly } = setup((f) => {
      f.assembly.solvedPoses['c-shaft']!.translationMm[2] += 1;
    });
    await controller.refresh();
    const e = controller.getSnapshot().evaluation;
    expect(e).toMatchObject({ status: 'ok', assembly: { poseMismatch: ['j-turn'] } });
    assembly.setJointDraft('j-slide', { fields: ['15'], shown: ['12'] });
    expect(await assembly.applyJointDraft('j-slide')).toBe(false);
    expect(controller.getSnapshot().diagnostic?.message).toContain('解き直す');
    expect(await assembly.solvePoses()).toBe(true);
    expect(z(controller, 'c-shaft')).toBe(5);
    expect(await assembly.removeJoint('j-slide')).toBe(true);
    const doc = controller.getSnapshot().content;
    expect(doc.joints.map((j) => j.id)).not.toContain('j-slide');
    expect(doc.components.find((c) => c.id === 'c-plate-2')!.placement).not.toBeNull();
    expect(z(controller, 'c-plate-2')).toBe(17);
  });
});
