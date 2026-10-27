import { EditorSession } from '@editor-platform/editor-core';
import { describe, expect, it } from 'vitest';
import { composePoses, posesDiffer, type CadSolvedPose } from './assembly';
import { CadAssemblyPort, type CadPartKernelPort } from './assembly-port';
import { CadCoordinator, type CadEvaluateRequest, type CadEvaluation } from './coordinator';
import { parameterValues } from './graph';
import { fixtureComponent, fixturePart, fixtureVersion } from './assembly-fixtures';
import { f20TopFace, f20TopFrame, r2bJoints } from './joints-fixtures';
import {
  connectorRefKey,
  invertPose,
  previewJointPose,
  solveJoints,
  type CadConnectorFrame,
} from './joints';
import { emptyCad, mm, type CadDocument } from './model';
import { applyCadOperation, cadContentHash, type CadOperation } from './operations';
import type { CadTopologyRef } from './topology';
import { validateCad } from './validation';

const turn = (deg: number): [number, number, number, number] => [
  0,
  0,
  Math.sin((deg * Math.PI) / 360),
  Math.cos((deg * Math.PI) / 360),
];
const pose = (t: [number, number, number], rotation = turn(0)): CadSolvedPose => ({
  translationMm: t,
  rotation,
});
const near = (a: CadSolvedPose, b: CadSolvedPose) => expect(posesDiffer(a, b)).toBe(false);
const codes = (doc: unknown) => validateCad(doc).map((d) => d.code);

/** Answers with the fixture's analytic frames; `frames` may be changed between jobs. */
function frameKernel(frames: Map<string, CadConnectorFrame>) {
  const jobs: CadEvaluateRequest[] = [];
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
              frames.get(`${at} ${connectorRefKey(r)}`) ?? { status: 'missing', candidates: [] },
          ),
        }
      : {}),
  });
  const kernel: CadPartKernelPort = {
    evaluate: async (request) => (jobs.push(request), answer(request, 'own')),
    evaluatePart: async (request) => (jobs.push(request), answer(request, request.candidateHash)),
    cancel: () => undefined,
  };
  return { kernel, jobs };
}
function setup(doc?: (d: CadDocument) => CadDocument, access?: (artifactId: string) => boolean) {
  const f = r2bJoints();
  const k = frameKernel(f.frames);
  const port = new CadAssemblyPort({
    kernel: k.kernel,
    parts: (h) => f.closure.get(h),
    ...(access ? { access } : {}),
  });
  const start = doc ? doc(structuredClone(f.assembly)) : f.assembly;
  const session = new EditorSession(start);
  const coordinator = new CadCoordinator({
    session,
    kernel: port,
    canEdit: () => true,
    permissionGeneration: () => 1,
  });
  const edit = async (op: CadOperation) => {
    const r = await coordinator.prepare(op);
    if (r.status !== 'ready') return r;
    return coordinator.apply(r.ticket);
  };
  return { ...f, k, port, session, coordinator, edit };
}

describe('joints (R2b-2, CAD47)', () => {
  it('solves each joint type from its connectors and values', () => {
    const { assembly: doc } = r2bJoints();
    expect(codes(doc)).toEqual([]);
    const p = doc.solvedPoses;
    near(p['c-shaft']!, pose([40, 25, 5], turn(30)));
    near(p['c-plate-2']!, pose([40, 25, 17], turn(30)));
    near(p['c-plate-3']!, pose([40, 25, 22], turn(120)));
    near(p['c-plate-1']!, pose([-120, 10, 0], turn(90)));
    // The pair's inner plate lies flipped on plate 1, 5 mm up the axis.
    const inner = composePoses(p['c-pair']!, pose([0, 0, 20]));
    expect(inner.translationMm.map((x) => +x.toFixed(9))).toEqual([-120, 10, 5]);
    near(
      p['c-pair']!,
      pose(
        [-120, 10, 25],
        composePoses(pose([0, 0, 0], turn(90)), pose([0, 0, 0], [1, 0, 0, 0])).rotation,
      ),
    );
  });

  it('previews a drag from the solved frames without a kernel', () => {
    const { assembly: doc, closure, frames } = r2bJoints();
    const s = solveJoints(
      doc,
      parameterValues(doc),
      (h) => closure.get(h),
      (at, ref) => frames.get(`${at} ${connectorRefKey(ref)}`),
      () => true,
    );
    const slide = s.joints['j-slide']!;
    expect(slide.status).toBe('solved');
    if (slide.status !== 'solved') return;
    near(previewJointPose({ type: 'slider' }, slide, { distance: 3 }), pose([40, 25, 8], turn(30)));
    near(invertPose(invertPose(slide.parent)), slide.parent);
  });

  it('refuses a cycle, two parents, a placed child, a value out of range, and stray values', () => {
    const { assembly } = r2bJoints();
    const base = () => structuredClone(assembly);
    let d = base();
    // c-plate-1 under c-pair, which rides on c-plate-1.
    d.joints.find((j) => j.id === 'j-plane')!.parent.componentPath = ['c-pair'];
    expect(codes(d)).toContain('joint-cycle');
    d = base();
    d.joints.find((j) => j.id === 'j-plane')!.child.componentId = 'c-shaft';
    expect(codes(d)).toEqual(
      expect.arrayContaining(['joint-multiple-parents', 'component-unplaced']),
    );
    d = base();
    d.components.find((c) => c.id === 'c-plate-2')!.placement = {
      translation: [mm(0), mm(0), mm(0)],
      rotation: [0, 0, 0, 1],
    };
    expect(codes(d)).toContain('joint-child-placed');
    d = base();
    d.joints.find((j) => j.id === 'j-slide')!.values = { distance: mm(21) };
    expect(codes(d)).toEqual(['joint-limit']);
    d = base();
    d.joints.find((j) => j.id === 'j-slide')!.values = {
      distance: mm(1),
      angle: { literalRad: 0 },
    };
    expect(codes(d)).toContain('unknown-field');
    d = base();
    d.joints.find((j) => j.id === 'j-slide')!.limits = [{ of: 'angle', min: 0, max: 1 }];
    expect(codes(d)).toContain('joint-limit-of');
    d = base();
    // This document's bodies are read only through an active body's result.
    d.joints.find((j) => j.id === 'j-turn')!.parent.ref = {
      ...f20TopFace,
      featureId: 'plate-extrude',
    };
    expect(codes(d)).toContain('reference-feature');
    d = base();
    d.joints.find((j) => j.id === 'j-ride')!.parent.componentPath = ['nowhere'];
    expect(codes(d)).toContain('connector-path');
    d = base();
    d.joints.find((j) => j.id === 'j-turn')!.type = 'ball' as never;
    expect(codes(d)).toContain('joint-type');
    // A joint angle may be negative; a dimension angle may not.
    d = base();
    d.joints.find((j) => j.id === 'j-plane')!.values.angle = { literalRad: -Math.PI / 2 };
    expect(codes(d)).toEqual([]);
  });

  it('checks stored poses against the joints after evaluation, and edits re-solve in one step', async () => {
    const s = setup();
    expect(await s.coordinator.refresh()).toBe('ready');
    const current = s.coordinator.evaluation;
    expect(current?.status === 'ok' && current.assembly?.poseMismatch).toEqual([]);
    const applied = await s.edit({
      type: 'setJointValues',
      jointId: 'j-slide',
      values: { distance: mm(15) },
    });
    expect(applied).toMatchObject({ status: 'applied' });
    const p = s.coordinator.content.solvedPoses;
    near(p['c-plate-2']!, pose([40, 25, 20], turn(30)));
    // A child of the moved child follows in the same edit.
    near(p['c-plate-3']!, pose([40, 25, 25], turn(120)));
    expect(s.session.canUndo).toBe(true);
    await s.coordinator.undo();
    near(s.coordinator.content.solvedPoses['c-plate-2']!, pose([40, 25, 17], turn(30)));
    // A parameter a joint reads moves its subtree.
    expect(
      await s.edit({ type: 'setParameter', parameterId: 'A', value: Math.PI / 2 }),
    ).toMatchObject({
      status: 'applied',
    });
    near(s.coordinator.content.solvedPoses['c-plate-3']!, pose([40, 25, 22], turn(180)));
    // A value past its limit is refused before any evaluation.
    expect(
      await s.edit({ type: 'setJointValues', jointId: 'j-slide', values: { distance: mm(25) } }),
    ).toMatchObject({
      status: 'rejected',
      code: expect.stringContaining('joint-limit'),
    });
  });

  it('holds edits of a document whose stored poses do not match until they are solved again', async () => {
    // The whole tree shifted by the same amount still fails: the root joint does not match.
    const s = setup((d) => {
      for (const id of Object.keys(d.solvedPoses)) d.solvedPoses[id]!.translationMm[2] += 1e-5;
      return d;
    });
    await s.coordinator.refresh();
    const e = s.coordinator.evaluation;
    expect(e?.status === 'ok' && e.assembly?.poseMismatch).toEqual([
      'j-turn',
      'j-slide',
      'j-fasten',
      'j-plane',
      'j-ride',
    ]);
    expect(
      await s.edit({ type: 'setJointValues', jointId: 'j-slide', values: { distance: mm(15) } }),
    ).toEqual({
      status: 'rejected',
      code: 'assembly-pose-mismatch',
    });
    expect(await s.edit({ type: 'solveAssemblyPoses' })).toMatchObject({ status: 'applied' });
    expect(cadContentHash(s.coordinator.content)).toBe(s.hash);
    // Solving again a document that matches is refused.
    expect(await s.edit({ type: 'solveAssemblyPoses' })).toEqual({
      status: 'rejected',
      code: 'assembly-poses-match',
    });
    // Within the residual (1e-6 mm) it matches.
    const t = setup((d) => ((d.solvedPoses['c-shaft']!.translationMm[0] += 9e-7), d));
    await t.coordinator.refresh();
    const f = t.coordinator.evaluation;
    expect(f?.status === 'ok' && f.assembly?.poseMismatch).toEqual([]);
  });

  it('refuses an edit that breaks a connector, and deleting the joint fixes its child in place', async () => {
    const s = setup();
    await s.coordinator.refresh();
    s.frames.set(`own ${connectorRefKey(f20TopFace)}`, { status: 'ambiguous', candidates: [] });
    expect(await s.edit({ type: 'setParameter', parameterId: 'T', value: 6 })).toMatchObject({
      status: 'geometry-error',
      evaluation: { code: 'connector-ambiguous', featureId: 'j-turn', brokenJoints: ['j-turn'] },
    });
    const before = s.coordinator.content.solvedPoses['c-shaft']!;
    expect(await s.edit({ type: 'deleteClosure', ids: ['j-turn'], cascade: false })).toMatchObject({
      status: 'applied',
    });
    const after = s.coordinator.content;
    expect(after.joints.map((j) => j.id)).not.toContain('j-turn');
    expect(after.components.find((c) => c.id === 'c-shaft')!.placement).not.toBeNull();
    near(after.solvedPoses['c-shaft']!, before);
  });

  it('deleting this document body takes the joints on its faces with it', () => {
    const { assembly } = r2bJoints();
    expect(() =>
      applyCadOperation(assembly, { type: 'deleteClosure', ids: ['plate'], cascade: false }),
    ).toThrow('delete-has-dependents');
    const next = applyCadOperation(assembly, {
      type: 'deleteClosure',
      ids: ['plate'],
      cascade: true,
    });
    expect(next.joints.map((j) => j.id)).toEqual(['j-slide', 'j-fasten', 'j-plane', 'j-ride']);
    expect(next.components.find((c) => c.id === 'c-shaft')!.placement).not.toBeNull();
  });

  it('asks a part for a new connector frame once, and keeps its cached result otherwise', async () => {
    const s = setup();
    await s.coordinator.refresh();
    const parts = () => s.k.jobs.filter((j) => j.requestId.includes('/part/')).length;
    const n = parts();
    expect(n).toBe(3);
    // A joint on the shaft's face: only the shaft is evaluated again, with that frame.
    const face = { ...f20TopFace, featureId: 'ring-placement', name: [['side']] };
    s.frames.set(`${s.shaft.contentHash} ${connectorRefKey(face)}`, {
      status: 'resolved',
      frame: pose([0, 0, 10]),
    });
    const op: CadOperation = {
      type: 'updateJoint',
      joint: {
        ...s.coordinator.content.joints.find((j) => j.id === 'j-slide')!,
        parent: {
          componentPath: ['c-shaft'],
          ref: face,
          flip: false,
          offset: { translation: [mm(0), mm(0), mm(0)], rotation: [0, 0, 0, 1] },
        },
      },
    };
    expect(await s.edit(op)).toMatchObject({ status: 'applied' });
    expect(parts()).toBe(n + 1);
    near(s.coordinator.content.solvedPoses['c-plate-2']!, pose([40, 25, 27], turn(30)));
    await s.edit({ type: 'setJointValues', jointId: 'j-slide', values: { distance: mm(2) } });
    expect(parts()).toBe(n + 1);
  });
  it('keeps a joint on a part it cannot read unavailable, origin connectors too, and holds what moves its child', async () => {
    const s = setup(undefined, (id) => id !== 'plate');
    await s.coordinator.refresh();
    const e = s.coordinator.evaluation;
    if (e?.status !== 'ok') throw new Error('evaluation');
    // Origin connectors read no frame, but the plate's version is still not readable here. The
    // parent side (on the shaft) still resolves.
    const slide = e.assembly?.joints?.['j-slide'];
    expect(slide?.status).toBe('unavailable');
    near(
      slide?.status === 'unavailable' ? slide.parent! : pose([0, 0, 0]),
      s.assembly.solvedPoses['c-shaft']!,
    );
    expect(e.assembly?.joints?.['j-turn']?.status).toBe('solved');
    expect(e.assembly?.poseMismatch).toEqual([]);
    expect(
      await s.edit({ type: 'setJointValues', jointId: 'j-slide', values: { distance: mm(15) } }),
    ).toEqual({ status: 'rejected', code: 'joint-part-unavailable' });
    // Turning the shaft would move the plate sliding on it: refused too.
    expect(await s.edit({ type: 'setParameter', parameterId: 'A', value: Math.PI / 3 })).toEqual({
      status: 'rejected',
      code: 'joint-part-unavailable',
    });
    // An edit that moves none of them applies, and the plates stay where they were saved.
    expect(await s.edit({ type: 'setParameter', parameterId: 'H', value: 60 })).toMatchObject({
      status: 'applied',
    });
    near(s.coordinator.content.solvedPoses['c-plate-2']!, s.assembly.solvedPoses['c-plate-2']!);
  });

  it('refuses a parameter edit that moves an unreadable joint by its connector offset', async () => {
    const s = setup(
      (d) => {
        d.parameters.push({ id: 'O', name: 'Offset', type: 'length', value: 0 });
        d.joints.find((j) => j.id === 'j-slide')!.parent.offset.translation[0] = {
          parameterId: 'O',
        };
        return d;
      },
      (id) => id !== 'plate',
    );
    await s.coordinator.refresh();
    expect(await s.edit({ type: 'setParameter', parameterId: 'O', value: 6 })).toEqual({
      status: 'rejected',
      code: 'joint-part-unavailable',
    });
  });

  it('refuses poses an edit supplies for the child of an unreadable joint', async () => {
    const s = setup(undefined, (id) => id !== 'plate');
    await s.coordinator.refresh();
    // Every joint child's pose, as the coordinator would write them, with one shifted 100 mm.
    const poses = Object.fromEntries(
      s.assembly.joints.map((j) => [
        j.child.componentId,
        structuredClone(s.assembly.solvedPoses[j.child.componentId]!),
      ]),
    );
    poses['c-plate-3']!.translationMm[0] += 100;
    expect(
      await s.edit({
        type: 'withSolvedPoses',
        edit: { type: 'setPartProperties', partNumber: 'P-1', description: '' },
        poses,
      }),
    ).toEqual({ status: 'rejected', code: 'joint-part-unavailable' });
    expect(cadContentHash(s.coordinator.content)).toBe(s.hash);
  });

  it('checks access along each connector path, not only for the content it reads', async () => {
    // The same plate content also placed from another Artifact that is still readable.
    const s = setup(
      (d) => {
        const alias = fixtureVersion('plate-alias', 'v1', r2bJoints().plate.content);
        d.parts.push(fixturePart('part-plate-alias', 'Plate copy', alias));
        d.components.push(fixtureComponent('c-alias', 'part-plate-alias', [0, 200, 0]));
        d.solvedPoses['c-alias'] = pose([0, 200, 0]);
        return d;
      },
      (id) => id !== 'plate',
    );
    await s.coordinator.refresh();
    const e = s.coordinator.evaluation;
    if (e?.status !== 'ok') throw new Error('evaluation');
    expect(e.assembly?.versions[s.plate.contentHash]?.state).toBe('available');
    expect(e.assembly?.joints?.['j-slide']?.status).toBe('unavailable');
    expect(
      await s.edit({ type: 'setJointValues', jointId: 'j-slide', values: { distance: mm(15) } }),
    ).toEqual({ status: 'rejected', code: 'joint-part-unavailable' });
  });

  it('solves a component whose ID is also an Object property name, in any joint order', () => {
    const { assembly, closure, frames } = r2bJoints();
    const doc = JSON.parse(
      JSON.stringify(assembly).replaceAll('"c-shaft"', '"toString"'),
    ) as CadDocument;
    doc.joints.reverse();
    expect(codes(doc)).toEqual([]);
    const s = solveJoints(
      doc,
      parameterValues(doc),
      (h) => closure.get(h),
      (at, ref) => frames.get(`${at} ${connectorRefKey(ref)}`),
      () => true,
    );
    expect(s.mismatch).toEqual([]);
    near(s.poses['c-plate-2']!, assembly.solvedPoses['c-plate-2']!);
  });

  it("connects at a vertex: its point with the part's axes (R2b-2c)", () => {
    const corner: CadTopologyRef = {
      kind: 'vertex',
      featureId: 'plate-cut-placement',
      name: [['end'], ['side:+u'], ['side:+v']],
      hint: { centroid: [80, 50, 5], size: 0 },
    };
    const f = r2bJoints();
    f.assembly.joints.find((j) => j.id === 'j-turn')!.parent.ref = corner;
    expect(codes(f.assembly)).toEqual([]);
    f.frames.set(`own ${connectorRefKey(corner)}`, {
      status: 'resolved',
      frame: { translationMm: [80, 50, 5], rotation: [0, 0, 0, 1] },
    });
    const s = solveJoints(
      f.assembly,
      parameterValues(f.assembly),
      (h) => f.closure.get(h),
      (at, ref) => f.frames.get(`${at} ${connectorRefKey(ref)}`),
      () => true,
    );
    // The shaft turns by A about the corner's z, as it did on the top face's centroid.
    near(s.poses['c-shaft']!, pose([80, 50, 5], turn(30)));
    const wrong = structuredClone(f.assembly);
    wrong.joints.find((j) => j.id === 'j-turn')!.parent.ref = { ...corner, name: [] };
    expect(codes(wrong)).toContain('reference-name');
  });

  it('checks connector path IDs and the joint type like other IDs and values', () => {
    const { assembly } = r2bJoints();
    const path = structuredClone(assembly);
    path.joints.find((j) => j.id === 'j-ride')!.child.connector.componentPath = ['part:1 ü'];
    expect(codes(path)).toEqual([]);
    const array = structuredClone(assembly) as unknown as { joints: { type: unknown }[] };
    array.joints[1]!.type = ['slider'];
    expect(codes(array)).toContain('joint-type');
  });

  it('shows a saved sub-assembly whose stored poses do not match its joints as that part failing', async () => {
    const f = r2bJoints();
    const tampered = structuredClone(f.assembly);
    tampered.solvedPoses['c-shaft']!.translationMm[2] += 1;
    const sub = fixtureVersion('sub', 'v1', tampered);
    const good = fixtureVersion('sub', 'v2', f.assembly);
    const closure = new Map([
      ...f.closure,
      [sub.contentHash, sub.content],
      [good.contentHash, good.content],
    ]);
    for (const v of [sub, good])
      f.frames.set(`${v.contentHash} ${connectorRefKey(f20TopFace)}`, {
        status: 'resolved',
        frame: f20TopFrame,
      });
    const outer = (v: typeof sub) =>
      applyCadOperation(emptyCad(f.assembly.kernelProfile), {
        type: 'insertComponents',
        parts: [fixturePart('p-sub', 'Sub', v)],
        components: [fixtureComponent('c-sub', 'p-sub')],
      });
    const k = frameKernel(f.frames);
    const port = new CadAssemblyPort({ kernel: k.kernel, parts: (h) => closure.get(h) });
    const evaluate = async (doc: CadDocument) => {
      const r = await port.evaluate({
        requestId: cadContentHash(doc),
        generation: 1,
        baseHash: '',
        candidateHash: cadContentHash(doc),
        document: doc,
      });
      if (r.status !== 'ok') throw new Error(r.code);
      return r.assembly!.versions;
    };
    expect((await evaluate(outer(sub)))[sub.contentHash]).toEqual({
      state: 'failed',
      code: 'part-pose-mismatch',
    });
    // Its own parts are still shown; the version that matches is available.
    expect((await evaluate(outer(sub)))[f.plate.contentHash]?.state).toBe('available');
    expect((await evaluate(outer(good)))[good.contentHash]?.state).toBe('available');
  });
});
