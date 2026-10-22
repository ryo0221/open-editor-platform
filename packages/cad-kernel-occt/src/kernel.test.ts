import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers';
import {
  applyCadOperation,
  cadContentHash,
  f02Plate,
  f02Volume,
  f03Revolve,
  f01Empty,
  f05Dependencies,
  identityQuaternion,
  mm,
  position,
  type CadDocument,
} from '@editor-platform/cad-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { createKernelHost } from './host';
import type { CadWorkerRequest, CadWorkerResponse } from './protocol';

// Opt-in: the development kernel (docs/verification/cad-d0) installed outside the repository.
const dist = process.env.CAD_OCCT_DIST;
describe.skipIf(!dist)('OCCT kernel host with the development build', () => {
  let buildHash = '';
  const posted: CadWorkerResponse[] = [];
  let handle: (m: CadWorkerRequest) => Promise<void>;
  const pinned = (doc: CadDocument): CadDocument => ({
    ...doc,
    kernelProfile: { ...doc.kernelProfile, buildHash },
  });
  const evaluate = async (requestId: string, doc: CadDocument) => {
    const document = pinned(doc);
    await handle({
      type: 'evaluate',
      requestId,
      generation: 1,
      baseHash: '',
      candidateHash: cadContentHash(document),
      document,
    });
    return posted.find((m) => 'requestId' in m && m.requestId === requestId)!;
  };
  beforeAll(async () => {
    const wasm = readFileSync(`${dist}/opencascade.full.wasm`);
    buildHash = `sha256:${createHash('sha256').update(wasm).digest('hex')}`;
    handle = createKernelHost({
      load: async () => {
        const { default: init } = await import(pathToFileURL(`${dist}/node.js`).href);
        return init({ module: { wasmBinary: wasm } });
      },
      post: (m) => void posted.push(m),
      yieldTask: () => new Promise((resolve) => setImmediate(resolve)),
    });
    await handle({ type: 'init', build: { buildHash, moduleUrl: '', wasmUrl: '' } });
  }, 300_000);

  it('evaluates F02 after a dimension change with metrics and a consistent mesh', async () => {
    expect(posted[0]).toEqual({ type: 'ready', buildHash });
    const doc = applyCadOperation(f02Plate(), {
      type: 'setParameter',
      parameterId: 'W',
      value: 100,
    });
    const result = await evaluate('f02', doc);
    if (result.type !== 'result' || result.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(result));
    const plate = result.evaluation.bodies.plate;
    expect(Math.abs(plate.volumeMm3 - f02Volume(100))).toBeLessThanOrEqual(1e-7 * f02Volume(100));
    expect(plate.bounds[1][0]).toBeCloseTo(100, 6);
    expect(Object.keys(result.evaluation.bodies)).toEqual(['plate']);
    const [mesh] = result.meshes;
    expect(mesh.bodyId).toBe('plate');
    expect(mesh.indices.length % 3).toBe(0);
    expect(Math.max(...mesh.indices)).toBeLessThan(mesh.positions.length / 3);
    expect(mesh.faceIds.length).toBe(mesh.indices.length / 3);
    expect(mesh.normals.length).toBe(mesh.positions.length);
    // Signed volume of the closed, outward-wound mesh approximates the exact volume.
    let signed = 0;
    const p = mesh.positions;
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const [a, b, c] = [mesh.indices[i] * 3, mesh.indices[i + 1] * 3, mesh.indices[i + 2] * 3];
      signed +=
        (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
          p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
          p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) /
        6;
    }
    expect(signed / plate.volumeMm3).toBeGreaterThan(0.99);
    expect(signed / plate.volumeMm3).toBeLessThan(1.01);
  });

  it('reports feature errors, a foreign build and cancellation without results', async () => {
    const disjoint = applyCadOperation(f05Dependencies(0), {
      type: 'booleanBodies',
      targetId: 'a',
      toolId: 'b',
      mode: 'union',
      booleanFeatureId: 'u',
      placementFeatureId: 'u-placement',
    });
    expect(await evaluate('split', disjoint)).toMatchObject({
      evaluation: { status: 'error', code: 'multiple-solids', featureId: 'u' },
    });
    const foreign = f03Revolve();
    await handle({
      type: 'evaluate',
      requestId: 'foreign',
      generation: 1,
      baseHash: '',
      candidateHash: cadContentHash(foreign),
      document: foreign,
    });
    expect(posted.at(-1)).toMatchObject({ evaluation: { code: 'kernel-build-unavailable' } });
    const job = evaluate('cancel-me', f02Plate());
    await handle({ type: 'cancel', requestId: 'cancel-me' });
    expect(await job).toEqual({ type: 'cancelled', requestId: 'cancel-me' });
    // The same instance continues after cancel.
    expect(await evaluate('after', f03Revolve())).toMatchObject({ evaluation: { status: 'ok' } });
  });

  it('keeps small bodies far from the origin distinct in the Float32 mesh', async () => {
    const far = 999_990;
    const doc = applyCadOperation(f01Empty(), {
      type: 'insertFeatures',
      parameters: [],
      profiles: [],
      features: [
        {
          id: 'tiny',
          name: 'Tiny',
          type: 'box',
          inputFeatureIds: [],
          args: {
            size: [mm(0.01), mm(0.01), mm(0.01)],
            origin: position(far, far, far),
            orientation: identityQuaternion(),
          },
        },
      ],
      bodies: [
        {
          id: 'tiny-body',
          name: 'Tiny',
          sourceFeatureId: 'tiny',
          placementFeatureId: 'tiny-placement',
          appearance: { color: '#9aa4b1', opacity: 1 },
        },
      ],
    });
    const result = await evaluate('far', doc);
    if (result.type !== 'result' || result.evaluation.status !== 'ok')
      throw new Error(JSON.stringify(result));
    const [mesh] = result.meshes;
    const [min, max] = result.evaluation.bodies['tiny-body'].bounds;
    for (let i = 0; i < mesh.positions.length; i += 3)
      for (let j = 0; j < 3; j++) {
        const world = mesh.origin[j] + mesh.positions[i + j];
        expect(world).toBeGreaterThanOrEqual(min[j] - 1e-6);
        expect(world).toBeLessThanOrEqual(max[j] + 1e-6);
      }
    // No triangle collapses: every normal is a unit vector.
    for (let i = 0; i < mesh.normals.length; i += 3)
      expect(Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2])).toBeCloseTo(
        1,
        5,
      );
  });
});
