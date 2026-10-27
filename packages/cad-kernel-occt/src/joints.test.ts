import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers';
import {
  applyCadOperation,
  CadAssemblyPort,
  cadContentHash,
  f01Empty,
  f02Plate,
  f20TopFace,
  faceNameKey,
  mm,
  position,
  posesDiffer,
  r2bJoints,
  r2bVersions,
  topologyRefOf,
  type CadFixtureVersion,
  type CadOperation,
  type CadConnectorFrame,
  type CadDocument,
  type CadEvaluateRequest,
  type CadPartKernelPort,
  type CadTopologyRef,
} from '@editor-platform/cad-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { createKernelHost } from './host';
import type { CadMesh, CadWorkerRequest, CadWorkerResponse } from './protocol';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';

// Opt-in: the development kernel (scripts/cad-kernel) built outside the repository.
const dist = process.env.CAD_OCCT_DIST;
describe.skipIf(!dist)('R2b-2 connector frames with the development build (CAD47)', () => {
  let buildHash = '';
  const posted: CadWorkerResponse[] = [];
  let handle: (m: CadWorkerRequest) => Promise<void>;
  let n = 0;
  const run = async (request: CadEvaluateRequest) => {
    const requestId = `${request.requestId}-${n++}`;
    await handle({ type: 'evaluate', ...request, requestId, generation: 1 });
    const m = posted.find(
      (x) => 'requestId' in x && x.requestId === requestId && x.type !== 'progress',
    );
    if (m?.type !== 'result') throw new Error(JSON.stringify(m));
    return m;
  };
  const request = (doc: CadDocument, id: string, connectors?: CadTopologyRef[]) => ({
    requestId: id,
    generation: 1,
    baseHash: '',
    candidateHash: cadContentHash(doc),
    document: doc,
    ...(connectors ? { connectors } : {}),
  });
  beforeAll(async () => {
    const wasm = readFileSync(`${dist}/${cadKernelBuild.wasm}`);
    const sha = createHash('sha256').update(wasm).digest('hex');
    if (sha !== cadKernelBuild.wasmSha256)
      throw new Error(`kernel Wasm ${sha} is not the pinned build`);
    buildHash = `sha256:${sha}`;
    globalThis.require ??= createRequire(import.meta.url);
    handle = createKernelHost({
      load: async () => {
        const { default: factory } = await import(
          pathToFileURL(`${dist}/${cadKernelBuild.js}`).href
        );
        return factory({ wasmBinary: wasm });
      },
      post: (m) => void posted.push(m),
      yieldTask: () => new Promise((resolve) => setImmediate(resolve)),
    });
    await handle({ type: 'init', build: { buildHash, moduleUrl: '', wasmUrl: '' } });
  }, 300_000);
  const on = (doc: CadDocument): CadDocument => ({
    ...doc,
    kernelProfile: { ...doc.kernelProfile, id: 'occt', buildHash },
  });
  const frame = (f: CadConnectorFrame | undefined) => {
    if (f?.status !== 'resolved') throw new Error(JSON.stringify(f));
    return {
      at: f.frame.translationMm.map((x) => +x.toFixed(6) + 0),
      z: zOf(f.frame.rotation).map((x) => +x.toFixed(9) + 0),
    };
  };
  /** The frame's z axis: the third column of its rotation. */
  const zOf = ([x, y, z, w]: number[]) => [
    2 * (x! * z! + y! * w!),
    2 * (y! * z! - x! * w!),
    1 - 2 * (x! * x! + y! * y!),
  ];

  it('reads planar, cylindrical and circular connectors from the exact geometry', async () => {
    const plate = on(f02Plate());
    const first = await run(request(plate, 'names'));
    const mesh = first.meshes.find((m: CadMesh) => m.bodyId === 'plate')!;
    const faces = mesh.topology.faces.map((f) => f.name!);
    const wall = faces.find((f) => f.some((s) => s.startsWith('tool:')) && f.includes('side'))!;
    const top = faces.find((f) => faceNameKey(f) === faceNameKey(['end']))!;
    expect(top).toBeTruthy();
    const ref = (
      kind: 'face' | 'edge',
      name: CadTopologyRef['name'],
      centroid: [number, number, number],
    ): CadTopologyRef => ({
      kind,
      featureId: 'plate-cut-placement',
      name,
      hint: { centroid, size: 1 },
    });
    const edge = [top, wall].sort((a, b) => (faceNameKey(a) < faceNameKey(b) ? -1 : 1));
    const side = faces.find(
      (f) =>
        faceNameKey(f) !== faceNameKey(top) &&
        !f.some((s) => s.startsWith('tool:')) &&
        faceNameKey(f) !== faceNameKey(['start']),
    )!;
    const line = [top, side].sort((a, b) => (faceNameKey(a) < faceNameKey(b) ? -1 : 1));
    const refs = [
      f20TopFace,
      ref('face', [wall], [40, 25, 2.5]),
      ref('edge', edge, [40, 25, 5]),
      ref('edge', line, [0, 0, 5]),
      ref('face', [['nowhere']], [0, 0, 0]),
      { ...f20TopFace, featureId: 'hole-cylinder' },
    ];
    const r = await run(request(plate, 'frames', refs));
    if (r.evaluation.status !== 'ok') throw new Error(JSON.stringify(r.evaluation));
    const got = r.evaluation.connectors!;
    expect(got).toHaveLength(6);
    // The top face: its centroid (the hole is centred) and outward +z, with the world axes.
    expect(frame(got[0])).toEqual({ at: [40, 25, 5], z: [0, 0, 1] });
    expect(
      got[0]!.status === 'resolved' && got[0]!.frame.rotation.map((x) => +x.toFixed(12) + 0),
    ).toEqual([0, 0, 0, 1]);
    // The hole's wall: its axis, through the foot of the wall's centroid.
    const cylinder = frame(got[1]);
    expect(cylinder.at).toEqual([40, 25, 2.5]);
    expect(Math.abs(cylinder.z[2]!)).toBe(1);
    // The hole's top edge: the circle's centre and its plane's normal.
    const circle = frame(got[2]);
    expect(circle.at).toEqual([40, 25, 5]);
    expect(Math.abs(circle.z[2]!)).toBe(1);
    // A straight edge is not a connector; names that do not resolve are said so.
    expect(got[3]).toEqual({ status: 'unsupported' });
    expect(got[4]).toEqual({ status: 'missing', candidates: [] });
    // Only an active body's result feature is read.
    expect(got[5]).toEqual({ status: 'missing', candidates: [] });
  }, 120_000);

  it('names a vertex by the faces around it and reads it as its exact point (R2b-2c)', async () => {
    const plate = on(f02Plate());
    const first = await run(request(plate, 'vertex-names'));
    const { topology } = first.meshes.find((m: CadMesh) => m.bodyId === 'plate')!;
    // The block's eight corners and the hole's two seam ends, each once, at the kernel's points.
    expect(topology.vertices).toHaveLength(10);
    const corner = topology.vertices.findIndex(
      (v) => v.centroid.map((x) => +x.toFixed(9) + 0).join() === '80,50,5',
    );
    expect(corner).toBeGreaterThanOrEqual(0);
    const ref = topologyRefOf(topology, 'vertex', corner, 'plate-cut-placement');
    expect(ref.name).toHaveLength(3);
    expect(ref.name.some((n) => faceNameKey(n) === faceNameKey(['end']))).toBe(true);
    expect(ref.select).toBeUndefined();
    const missing: CadTopologyRef = { ...ref, name: [['end'], ['nowhere'], ['start']] };
    const r = await run(request(plate, 'vertex-frames', [ref, missing]));
    if (r.evaluation.status !== 'ok') throw new Error(JSON.stringify(r.evaluation));
    const [got, gone] = r.evaluation.connectors!;
    // The point itself, with the part's own axes.
    expect(frame(got)).toEqual({ at: [80, 50, 5], z: [0, 0, 1] });
    expect(got!.status === 'resolved' && got!.frame.rotation).toEqual([0, 0, 0, 1]);
    expect(gone).toEqual({ status: 'missing', candidates: [] });
  }, 120_000);
  it('reads a cone by its axis, like a cylinder', async () => {
    // A triangle r ∈ [10, 15], z ∈ [0, 20] revolved about Z: a plane, a cylinder and a cone.
    const doc = on(
      applyCadOperation(f01Empty(), {
        type: 'insertFeatures',
        profiles: [
          {
            id: 'tri',
            name: 'Triangle',
            plane: { origin: position(0, 0, 0), orientation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
            shape: {
              type: 'polyline',
              vertices: [
                { id: 'a', u: mm(10), v: mm(0) },
                { id: 'b', u: mm(15), v: mm(0) },
                { id: 'c', u: mm(10), v: mm(20) },
              ],
            },
          },
        ],
        features: [
          {
            id: 'cone-revolve',
            name: 'Cone',
            type: 'revolve',
            inputFeatureIds: [],
            args: {
              profileId: 'tri',
              axisOrigin: [mm(0), mm(0)],
              axisDirection: [0, 1],
              angle: { literalRad: 2 * Math.PI },
            },
          },
        ],
        bodies: [
          {
            id: 'cone',
            name: 'Cone',
            sourceFeatureId: 'cone-revolve',
            placementFeatureId: 'cone-placement',
            appearance: { color: '#888888', opacity: 1 },
          },
        ],
      }),
    );
    const first = await run(request(doc, 'cone-names'));
    const faces = first.meshes[0]!.topology.faces;
    expect(faces).toHaveLength(3);
    const refs: CadTopologyRef[] = faces.map((f) => ({
      kind: 'face',
      featureId: 'cone-placement',
      name: [f.name!],
      hint: { centroid: f.centroid, size: f.area },
    }));
    const r = await run(request(doc, 'cone-frames', refs));
    if (r.evaluation.status !== 'ok') throw new Error(JSON.stringify(r.evaluation));
    const frames = r.evaluation.connectors!.map(frame);
    // Every face's frame lies on the axis and points along it.
    for (const f of frames) {
      expect(f.at.slice(0, 2)).toEqual([0, 0]);
      expect(Math.abs(f.z[2]!)).toBe(1);
    }
  }, 120_000);

  it('solves F20 on the real kernel to the stored poses (CAD47)', async () => {
    const f = r2bJoints({ id: 'occt', buildHash });
    const kernel: CadPartKernelPort = {
      evaluate: async (r) => (await run(r)).evaluation,
      evaluatePart: async (r) => (await run(r)).evaluation,
      cancel: () => {},
    };
    const port = new CadAssemblyPort({ kernel, parts: (h) => f.closure.get(h) });
    const result = await port.evaluate(request(f.assembly, 'f20'));
    if (result.status !== 'ok') throw new Error(JSON.stringify(result));
    const a = result.assembly!;
    expect(Object.values(a.joints!).map((j) => j.status)).toEqual(Array(5).fill('solved'));
    expect(a.poseMismatch).toEqual([]);
    for (const [id, p] of Object.entries(a.poses!))
      expect(posesDiffer(p, f.assembly.solvedPoses[id]!), id).toBe(false);
    // The connectors stay out of the assembly's own evaluation.
    expect('connectors' in result).toBe(false);
  }, 120_000);
  it('classifies F21 base versions on the real kernel: resolved, ambiguous with candidates, missing (CAD48)', async () => {
    const f = r2bVersions({ id: 'occt', buildHash });
    const kernel: CadPartKernelPort = {
      evaluate: async (r) => (await run(r)).evaluation,
      evaluatePart: async (r) => (await run(r)).evaluation,
      cancel: () => {},
    };
    const port = new CadAssemblyPort({ kernel, parts: (h) => f.closure.get(h) });
    const replace = (doc: CadDocument, partId: string, v: CadFixtureVersion) =>
      applyCadOperation(doc, {
        type: 'replacePartSources',
        parts: [
          {
            partId,
            source: {
              kind: 'version',
              artifactId: v.artifactId,
              versionId: v.versionId,
              contentHash: v.contentHash,
            },
            hint: {
              boundsMm: [
                [0, 0, 0],
                [100, 50, 5],
              ],
            },
          },
        ],
      });
    const solve = async (doc: CadDocument, id: string) => {
      const result = await port.evaluate(request(doc, id));
      if (result.status !== 'ok') throw new Error(JSON.stringify(result));
      return result.assembly!;
    };
    const at = (doc: CadDocument, a: Awaited<ReturnType<typeof solve>>, c: string) =>
      a.poses![c]!.translationMm.map((x) => +x.toFixed(6) + 0);
    const first = await solve(f.assembly, 'f21-v1');
    expect(first.joints!['j-axle']!.status).toBe('solved');
    expect(first.poseMismatch).toEqual([]);
    const v2 = replace(f.assembly, 'part-base', f.bases[1]!);
    expect(at(v2, await solve(v2, 'f21-v2'), 'c-shaft')).toEqual([50, 25, 5]);
    const v3 = replace(f.assembly, 'part-base', f.bases[2]!);
    const split = (await solve(v3, 'f21-v3')).joints!['j-axle']!;
    if (split.status !== 'broken') throw new Error(JSON.stringify(split));
    expect(split.problems.map((p) => p.code)).toEqual(['connector-ambiguous']);
    const candidates = split.problems[0]!.candidates!;
    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => !!c.ref)).toBe(true);
    // Choosing a half again resolves it on its centroid.
    const op: CadOperation = {
      type: 'rebindReferences',
      edit: {
        type: 'replacePartSources',
        parts: [
          {
            partId: 'part-base',
            source: {
              kind: 'version',
              artifactId: 'base',
              versionId: 'v3',
              contentHash: f.bases[2]!.contentHash,
            },
            hint: {
              boundsMm: [
                [0, 0, 0],
                [80, 50, 5],
              ],
            },
          },
        ],
      },
      bindings: [{ featureId: 'j-axle', path: ['parent', 'ref'], ref: candidates[0]!.ref! }],
    };
    const chosen = applyCadOperation(f.assembly, op);
    const c = candidates[0]!.hint.centroid.map((x) => +x.toFixed(6) + 0);
    expect(at(chosen, await solve(chosen, 'f21-v3-chosen'), 'c-shaft')).toEqual(c);
    // A half of the top beside the groove (x < 37 or x > 43; the hole takes a little of each).
    expect(Math.abs(c[0]! - 40)).toBeGreaterThan(20);
    const v4 = replace(f.assembly, 'part-base', f.bases[3]!);
    expect((await solve(v4, 'f21-v4')).joints!['j-axle']).toMatchObject({
      status: 'broken',
      problems: [{ side: 'parent', code: 'connector-missing' }],
    });
    // Through the tower: its upper base gone, or base v3 there.
    const t2 = replace(f.assembly, 'part-tower', f.towers[1]!);
    expect((await solve(t2, 'f21-t2')).joints!['j-cap']).toEqual({
      status: 'broken',
      problems: [{ side: 'parent', code: 'connector-missing' }],
    });
    const t3 = replace(f.assembly, 'part-tower', f.towers[2]!);
    expect((await solve(t3, 'f21-t3')).joints!['j-cap']).toMatchObject({
      status: 'broken',
      problems: [{ code: 'connector-ambiguous' }],
    });
  }, 180_000);
});
