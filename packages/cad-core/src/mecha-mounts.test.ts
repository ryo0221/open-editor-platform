import { EditorSession } from '@editor-platform/editor-core';
import { describe, expect, it } from 'vitest';
import { CadAssemblyPort, type CadPartKernelPort } from './assembly-port';
import { CadCoordinator, type CadEvaluateRequest, type CadEvaluation } from './coordinator';
import { assertCadOperation } from './commands';
import {
  configurationsApply,
  currentConfigurationValues,
  matchingConfigurations,
} from './configurations';
import { parameterValues } from './graph';
import { checkCadInterference, checkCadInterferenceAlong } from './interference';
import { posesForJointValues, solveJoints } from './joints';
import { fixtureComponent } from './assembly-fixtures';
import { fixtureConnector, fixtureJoint } from './joints-fixtures';
import { mr7ToolMount } from './mecha-fixtures';
import { identityPose } from './assembly';
import { position } from './model';
import type { CadInterferenceMesh } from './interference';
import type { CadDocument } from './model';
import { mountGaps } from './mount-gaps';
import { activeJoints, currentMounts } from './mounts';
import { applyCadOperation, type CadOperation } from './operations';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => d.code);
const run = (doc: CadDocument, op: CadOperation) => {
  assertCadOperation(op);
  return applyCadOperation(doc, op);
};
const refused = (doc: CadDocument, op: CadOperation) => {
  try {
    run(doc, op);
  } catch (e) {
    return (e as Error).message;
  }
  return 'applied';
};
const f = mr7ToolMount();
const lookup = (h: string) => f.closure.get(h);
const solve = (doc: CadDocument) =>
  solveJoints(
    doc,
    parameterValues(doc),
    lookup,
    () => undefined,
    () => true,
  );
/** Every part as a 10 mm cube at its origin (two triangles per face). */
const cube = (): CadInterferenceMesh[] => {
  const p = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10];
  const f = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7],
  ];
  return [{ bodyId: 'b-plate', origin: [0, 0, 0], positions: p, indices: f.flat() }];
};
const near = (v: readonly number[]) => v.map((x) => Math.round(x * 1000) / 1000 + 0);

describe('MR7a mounts: a component with candidate joints (TS-1717)', () => {
  it('validates a mount and refuses a second joint without one, or a candidate left out', () => {
    expect(codes(f.assembly)).toEqual([]);
    const bare = structuredClone(f.assembly);
    delete bare.mounts;
    expect(codes(bare)).toContain('joint-multiple-parents');
    const partial = structuredClone(f.assembly);
    partial.mounts![0]!.joints = ['j-tool-hand', 'j-wrist'];
    expect(codes(partial)).toEqual(
      expect.arrayContaining(['mount-joint-child', 'mount-joint-missing']),
    );
    const off = structuredClone(f.assembly);
    off.mounts![0]!.active = 'j-wrist';
    expect(codes(off)).toContain('mount-active');
  });
  it('refuses a candidate that would close a loop through the component', () => {
    const doc = structuredClone(f.assembly);
    // The hand hangs from the tool: with the tool on the hand, a cycle.
    const wrist = doc.joints.find((j) => j.id === 'j-wrist')!;
    wrist.parent.componentPath = ['c-tool'];
    expect(codes(doc)).toContain('joint-cycle');
  });
  it('places the component by the joint in effect only; a switch is one edit and one Undo', () => {
    const s = solve(f.assembly);
    expect(s.mismatch).toEqual([]);
    // Both candidates solve (the frames are kept to switch to), only the hand places the tool.
    expect(s.joints['j-tool-back']?.status).toBe('solved');
    const hand = s.poses['c-tool']!;
    const back = run(f.assembly, { type: 'setMount', mountId: 'm-tool', jointId: 'j-tool-back' });
    expect(back.mounts![0]!.active).toBe('j-tool-back');
    const after = solve(back);
    // The stored pose is still the hand's: the coordinator writes the solved one into the edit.
    expect(after.mismatch).toEqual(['j-tool-back']);
    expect(near(after.poses['c-tool']!.translationMm)).toEqual([0, 60, 150]);
    expect(near(hand.translationMm)).not.toEqual([0, 60, 150]);
    expect(f.assembly.mounts![0]!.active).toBe('j-tool-hand');
    expect(refused(f.assembly, { type: 'setMount', mountId: 'm-tool', jointId: 'j-wrist' })).toBe(
      'mount-joint',
    );
  });
  it('moves the component by a chosen candidate for given values, and measures the gap', () => {
    const s = solve(f.assembly);
    const doc = { ...f.assembly, solvedPoses: s.poses };
    const back = posesForJointValues(
      doc,
      s,
      new Map(),
      parameterValues(doc),
      new Map([['m-tool', 'j-tool-back']]),
    );
    expect(near(back['c-tool']!.translationMm)).toEqual([0, 60, 150]);
    expect(activeJoints(doc, new Map([['m-tool', 'j-tool-back']])).map((j) => j.id)).not.toContain(
      'j-tool-hand',
    );
    const gaps = mountGaps(doc, s.joints);
    expect(gaps.map((g) => [g.joint, g.within])).toEqual([
      ['j-tool-hand', true],
      ['j-tool-back', false],
    ]);
    expect(gaps[1]!.mm).toBeGreaterThan(50);
  });
  it('adds a candidate as a mount, and removing the mount keeps only the joint in effect', () => {
    const doc = structuredClone(f.assembly);
    doc.joints = doc.joints.filter((j) => j.id !== 'j-tool-back');
    delete doc.mounts;
    const back = f.assembly.joints.find((j) => j.id === 'j-tool-back')!;
    // A second joint for the tool without a mount is refused by validation.
    expect(refused(doc, { type: 'insertJoint', joint: back })).toMatch(/joint-multiple-parents/);
    const mounted = run(doc, {
      type: 'insertMountJoint',
      joint: back,
      mount: { id: 'm-new', name: 'Tool' },
    });
    expect(mounted.mounts).toEqual([
      {
        id: 'm-new',
        name: 'Tool',
        component: 'c-tool',
        joints: ['j-tool-hand', 'j-tool-back'],
        active: 'j-tool-hand',
      },
    ]);
    expect(codes(mounted)).toEqual([]);
    const removed = run(f.assembly, { type: 'removeMount', mountId: 'm-tool' });
    expect(removed.mounts).toBeUndefined();
    expect(removed.joints.some((j) => j.id === 'j-tool-back')).toBe(false);
    expect(codes(removed)).toEqual([]);
    // Renamed like any element.
    expect(
      run(f.assembly, { type: 'rename', targetId: 'm-tool', name: 'Rifle' }).mounts![0]!.name,
    ).toBe('Rifle');
  });
  it('deleting the candidate in effect hands over to the one left, without fixing the part', () => {
    const doc = run(f.assembly, { type: 'deleteClosure', ids: ['j-tool-hand'], cascade: false });
    expect(doc.mounts).toBeUndefined();
    expect(doc.components.find((c) => c.id === 'c-tool')!.placement).toBeNull();
    expect(codes(doc)).toEqual([]);
  });
  it('a form keeps its mounts: stale without them, recalled with them, matched by them', () => {
    const values = currentConfigurationValues(f.assembly);
    const doc = run(f.assembly, {
      type: 'insertConfiguration',
      configuration: { id: 'form-hand', name: 'Hand', values, mounts: currentMounts(f.assembly)! },
    });
    expect(
      refused(doc, {
        type: 'insertConfiguration',
        configuration: { id: 'form-x', name: 'X', values },
      }),
    ).toBe('configuration-stale');
    const back = run(doc, { type: 'setMount', mountId: 'm-tool', jointId: 'j-tool-back' });
    expect(matchingConfigurations(back)).toEqual([]);
    const saved = run(back, {
      type: 'insertConfiguration',
      configuration: { id: 'form-back', name: 'Back', values, mounts: currentMounts(back)! },
    });
    const recalled = run(saved, { type: 'recallConfiguration', id: 'form-hand' });
    expect(recalled.mounts![0]!.active).toBe('j-tool-hand');
    expect(matchingConfigurations(recalled)).toEqual(['form-hand']);
    expect(codes(saved)).toEqual([]);
  });
  it('has forms for an assembly whose joints are all fastened, by its mounts alone', () => {
    const f = mr7ToolMount();
    // Every joint fastened where it stands: no joint moves, the mount still does.
    const doc: CadDocument = {
      ...f.assembly,
      joints: f.assembly.joints.map(({ couplings: _, ...j }) => ({
        ...j,
        type: 'fastened' as const,
        values: {},
        limits: [],
      })),
    };
    expect(currentConfigurationValues(doc)).toEqual({});
    expect(configurationsApply(doc)).toBe(true);
    expect(configurationsApply({ ...doc, mounts: undefined })).toBe(false);
    const saved = run(doc, {
      type: 'insertConfiguration',
      configuration: { id: 'form-hand', name: 'Hand', values: {}, mounts: currentMounts(doc)! },
    });
    const back = run(saved, { type: 'setMount', mountId: 'm-tool', jointId: 'j-tool-back' });
    expect(matchingConfigurations(back)).toEqual([]);
    const recalled = run(back, { type: 'recallConfiguration', id: 'form-hand' });
    expect(matchingConfigurations(recalled)).toEqual(['form-hand']);
  });
  it('checks interference with the candidate in effect; its joint sphere only then', () => {
    const doc = structuredClone(f.assembly);
    doc.interferenceAllowances = [
      {
        id: 'allow-back',
        a: [],
        b: ['c-tool'],
        region: { kind: 'joint-sphere', joint: 'j-tool-back', radiusMm: 5 },
      },
    ];
    const s = solve(doc);
    const input = { doc, lookup, meshesOf: () => cube(), joints: s.joints };
    // Not in effect: neither applied nor stale; in effect (a sampled choice), applied.
    const hand = checkCadInterference(input);
    expect(hand.status === 'ok' && hand.stale).toEqual([]);
    const back = checkCadInterference({ ...input, mounts: new Map([['m-tool', 'j-tool-back']]) });
    expect(back.status === 'ok' && back.stale).toEqual([]);
    // A broken candidate not in effect does not stop a check with values.
    const broken = { ...s.joints, 'j-tool-back': { status: 'broken' as const, problems: [] } };
    expect(checkCadInterference({ ...input, joints: broken, values: new Map() }).status).toBe('ok');
  });
  it('reports a switch that moves the part along a motion (a jump), and none when it is held', () => {
    const doc = f.assembly;
    const s = solve(doc);
    const sweep = (mounts: string[]) =>
      checkCadInterferenceAlong(
        { doc, lookup, meshesOf: () => cube(), joints: s.joints },
        mounts.map((m, i) => ({ tick: i, values: new Map(), mounts: new Map([['m-tool', m]]) })),
      );
    const jumped = sweep(['j-tool-hand', 'j-tool-back']);
    if (jumped.status !== 'ok') throw new Error(jumped.code);
    expect(jumped.jumps).toMatchObject([
      { tick: 1, mount: 'm-tool', from: 'j-tool-hand', to: 'j-tool-back' },
    ]);
    const held = sweep(['j-tool-hand', 'j-tool-hand']);
    expect(held.status === 'ok' && held.jumps).toEqual([]);
    // A switch at the first sample is measured against the document's own choice (Codex #1023).
    const first = sweep(['j-tool-back']);
    expect(first.status === 'ok' && first.jumps).toMatchObject([
      { tick: 0, mount: 'm-tool', from: 'j-tool-hand', to: 'j-tool-back' },
    ]);
  });
  it('refuses to put in effect a candidate whose part cannot be read here (Codex #1020)', async () => {
    const answer = (request: CadEvaluateRequest): CadEvaluation => ({
      status: 'ok',
      contentHash: request.candidateHash,
      buildHash: request.document.kernelProfile.buildHash,
      geometryDigest: 'd',
      bodies: {},
      ...(request.connectors
        ? { connectors: request.connectors.map(() => ({ status: 'missing', candidates: [] })) }
        : {}),
    });
    const kernel: CadPartKernelPort = {
      evaluate: async (request) => answer(request),
      evaluatePart: async (request) => answer(request),
      cancel: () => undefined,
    };
    // No part version may be read: every joint keeps its child's stored pose.
    const coordinatorFor = async (doc: CadDocument) => {
      const port = new CadAssemblyPort({ kernel, parts: lookup, access: () => false });
      const coordinator = new CadCoordinator({
        session: new EditorSession(doc),
        kernel: port,
        canEdit: () => true,
        permissionGeneration: () => 1,
      });
      await coordinator.refresh();
      return coordinator;
    };
    const c = await coordinatorFor(f.assembly);
    const e = c.evaluation;
    expect(e?.status === 'ok' && e.assembly?.joints?.['j-tool-back']?.status).toBe('unavailable');
    expect(
      await c.prepare({ type: 'setMount', mountId: 'm-tool', jointId: 'j-tool-back' }),
    ).toEqual({ status: 'rejected', code: 'joint-part-unavailable' });
    // Nor through a form that has the other candidate in effect.
    const withForm = run(f.assembly, {
      type: 'insertConfiguration',
      configuration: {
        id: 'form-back',
        name: 'Back',
        values: currentConfigurationValues(f.assembly),
        mounts: { 'm-tool': 'j-tool-back' },
      },
    });
    const d = await coordinatorFor(withForm);
    expect(await d.prepare({ type: 'recallConfiguration', id: 'form-back' })).toEqual({
      status: 'rejected',
      code: 'joint-part-unavailable',
    });
    // Recalling the form already in effect changes no candidate.
    const hand = run(withForm, {
      type: 'insertConfiguration',
      configuration: {
        id: 'form-hand',
        name: 'Hand',
        values: currentConfigurationValues(f.assembly),
        mounts: { 'm-tool': 'j-tool-hand' },
      },
    });
    const h = await coordinatorFor(hand);
    expect((await h.prepare({ type: 'recallConfiguration', id: 'form-hand' })).status).toBe(
      'ready',
    );
  });
  it('a sample without mounts checks the document’s, whatever the input carries (Codex #1020)', () => {
    const s = solve(f.assembly);
    // An obstacle of the document's own where the back would put the tool.
    const ownMeshes = f.assembly.bodies
      .filter((b) => b.state === 'active')
      .map((b) => ({
        ...cube()[0]!,
        bodyId: b.id,
        origin: [-5, 55, 145] as [number, number, number],
      }));
    const meshesOf = (hash: string) =>
      lookup(hash)!
        .bodies.filter((b) => b.state === 'active')
        .map((b) => ({ ...cube()[0]!, bodyId: b.id }));
    const input = { doc: f.assembly, lookup, meshesOf, joints: s.joints, ownMeshes };
    const samples = [{ tick: 0, values: new Map() }];
    const plain = checkCadInterferenceAlong(input, samples);
    const carried = checkCadInterferenceAlong(
      { ...input, mounts: new Map([['m-tool', 'j-tool-back']]) },
      samples,
    );
    expect(carried).toEqual(plain);
    // The back is a different check: the input's choice was really ignored above.
    const back = checkCadInterferenceAlong(input, [
      { ...samples[0]!, mounts: new Map([['m-tool', 'j-tool-back']]) },
    ]);
    expect(back).not.toEqual(plain);
  });
  it('measures a switch with every mount’s choice before and after, a parent switching too (Codex #1020)', () => {
    // A holder on one of two places 100 mm apart, and the tool 100 mm out on the holder or
    // fixed where the holder's second place puts it: switching both at once moves only the holder.
    const doc = structuredClone(f.assembly);
    const atX = (path: string[], x: number) => ({
      ...fixtureConnector(path),
      offset: {
        translation: position(x, 0, 0),
        rotation: [0, 0, 0, 1] as [number, number, number, number],
      },
    });
    doc.components.push({ ...fixtureComponent('c-holder', 'part-plate'), placement: null });
    doc.solvedPoses['c-holder'] = identityPose();
    doc.joints = doc.joints.filter((j) => j.child.componentId !== 'c-tool');
    doc.joints.push(
      fixtureJoint('j-holder-a', 'fastened', atX([], 0), 'c-holder', fixtureConnector()),
      fixtureJoint('j-holder-b', 'fastened', atX([], 100), 'c-holder', fixtureConnector()),
      fixtureJoint('j-tool-on', 'fastened', atX(['c-holder'], 100), 'c-tool', fixtureConnector()),
      fixtureJoint('j-tool-fixed', 'fastened', atX([], 100), 'c-tool', fixtureConnector()),
    );
    doc.mounts = [
      {
        id: 'm-holder',
        name: 'Holder',
        component: 'c-holder',
        joints: ['j-holder-a', 'j-holder-b'],
        active: 'j-holder-a',
      },
      {
        id: 'm-tool',
        name: 'Tool',
        component: 'c-tool',
        joints: ['j-tool-on', 'j-tool-fixed'],
        active: 'j-tool-on',
      },
    ];
    const s = solve(doc);
    doc.solvedPoses = s.poses;
    expect(codes(doc)).toEqual([]);
    const r = checkCadInterferenceAlong({ doc, lookup, meshesOf: () => cube(), joints: s.joints }, [
      { tick: 0, values: new Map() },
      {
        tick: 1,
        values: new Map(),
        mounts: new Map([
          ['m-holder', 'j-holder-b'],
          ['m-tool', 'j-tool-fixed'],
        ]),
      },
    ]);
    if (r.status !== 'ok') throw new Error(r.code);
    expect(r.jumps.map((j) => [j.mount, Math.round(j.mm)])).toEqual([['m-holder', 100]]);
  });
});
