import { describe, expect, it } from 'vitest';
import type { CadPartVersionSource } from './assembly';
import { r2bParts } from './assembly-fixtures';
import { CadAssemblyPort, type CadPartKernelPort } from './assembly-port';
import type { CadEvaluateRequest, CadEvaluation } from './coordinator';
import { fixtureKernel } from './fixtures';
import { applyCadOperation, cadContentHash } from './operations';
import { mm, type CadDocument } from './model';

/** Answers every job ok with the document's own build; parts of `substitute` builds as reference. */
function fakeKernel(options: { substitute?: string; hold?: boolean } = {}) {
  const jobs: { id: string; part: boolean; hash: string }[] = [];
  const cancelled: string[] = [];
  const held: (() => void)[] = [];
  const answer = (request: CadEvaluateRequest, reference?: boolean): CadEvaluation => ({
    status: 'ok',
    contentHash: request.candidateHash,
    buildHash: request.document.kernelProfile.buildHash,
    geometryDigest: 'd',
    bodies: {},
    ...(reference ? { reference: true as const } : {}),
  });
  const wait = <T>(value: T) =>
    options.hold
      ? new Promise<T>((resolve) => held.push(() => resolve(value)))
      : Promise.resolve(value);
  const kernel: CadPartKernelPort = {
    evaluate(request) {
      jobs.push({ id: request.requestId, part: false, hash: request.candidateHash });
      return wait(answer(request));
    },
    evaluatePart(request, assembly) {
      jobs.push({ id: request.requestId, part: true, hash: request.candidateHash });
      const build = request.document.kernelProfile.buildHash;
      if (build === assembly.buildHash) return wait(answer(request));
      if (build === options.substitute) return wait(answer(request, true));
      return wait({
        status: 'error',
        contentHash: request.candidateHash,
        code: 'part-build-mismatch',
        retryable: false,
      });
    },
    cancel: (id) => void cancelled.push(id),
  };
  return { kernel, jobs, cancelled, held };
}
const request = (document: CadDocument, id = 'r1'): CadEvaluateRequest => ({
  requestId: id,
  generation: 0,
  baseHash: cadContentHash(document),
  candidateHash: cadContentHash(document),
  document,
});

describe('per-part evaluation (R2b-1, CAD49/CAD50/CAD51)', () => {
  it('evaluates each version once, and a placement edit evaluates no part again', async () => {
    const { assembly, closure, plate, shaft, pair } = r2bParts();
    const k = fakeKernel();
    const port = new CadAssemblyPort({ kernel: k.kernel, parts: (h) => closure.get(h) });
    const first = await port.evaluate(request(assembly));
    expect(first.status).toBe('ok');
    // The plate is placed three times (twice directly, twice in the pair) but evaluated once.
    expect(k.jobs.filter((j) => j.part).map((j) => j.hash)).toEqual([
      plate.contentHash,
      shaft.contentHash,
      pair.contentHash,
    ]);
    expect(
      first.status === 'ok' && Object.values(first.assembly!.versions).map((v) => v.state),
    ).toEqual(['available', 'available', 'available']);
    const moved = applyCadOperation(assembly, {
      type: 'setComponentPlacement',
      componentId: 'c-shaft',
      placement: { translation: [mm(1), mm(2), mm(3)], rotation: [0, 0, 0, 1] },
    });
    await port.evaluate(request(moved, 'r2'));
    expect(port.partEvaluations).toBe(3);
    expect(k.jobs.filter((j) => !j.part)).toHaveLength(2);
    // Forgetting a part (its meshes were released) evaluates only that part again.
    port.forget(shaft.contentHash);
    await port.evaluate(request(moved, 'r3'));
    expect(
      k.jobs
        .filter((j) => j.part)
        .map((j) => j.hash)
        .slice(3),
    ).toEqual([shaft.contentHash]);
  });

  it('evaluates the parts again when the assembly moves to another build', async () => {
    const { assembly, closure, plate } = r2bParts();
    const k = fakeKernel();
    const port = new CadAssemblyPort({ kernel: k.kernel, parts: (h) => closure.get(h) });
    await port.evaluate(request(assembly));
    expect(port.partEvaluations).toBe(3);
    const other = `sha256:${'c'.repeat(64)}`;
    const migrated: CadDocument = {
      ...assembly,
      kernelProfile: { ...assembly.kernelProfile, buildHash: other },
    };
    const result = await port.evaluate(request(migrated, 'r2'));
    // The parts still name the earlier build: no exact result from it is reused.
    expect(port.partEvaluations).toBe(6);
    expect(result.status === 'ok' && result.assembly!.versions[plate.contentHash]).toEqual({
      state: 'unavailable',
      code: 'part-build-mismatch',
    });
  });

  it('reports missing, tampered, revoked and other-build versions without failing the assembly', async () => {
    const { assembly, closure, plate, shaft, pair } = r2bParts();
    const tampered = structuredClone(closure.get(shaft.contentHash)!);
    tampered.parameters[0] = { ...tampered.parameters[0]!, name: 'changed' } as never;
    const otherBuild = structuredClone(plate.content);
    otherBuild.kernelProfile.buildHash = `sha256:${'b'.repeat(64)}`;
    const k = fakeKernel({ substitute: `sha256:${'b'.repeat(64)}` });
    const parts = new Map(closure);
    parts.set(shaft.contentHash, tampered);
    parts.delete(pair.contentHash);
    const port = new CadAssemblyPort({ kernel: k.kernel, parts: (h) => parts.get(h) });
    const result = await port.evaluate(request(assembly));
    expect(result.status === 'ok' && result.assembly!.versions).toEqual({
      [plate.contentHash]: expect.objectContaining({ state: 'available' }),
      [shaft.contentHash]: { state: 'unavailable', code: 'part-source-mismatch' },
      [pair.contentHash]: { state: 'unavailable', code: 'part-source-missing' },
    });
    const revoked = new CadAssemblyPort({
      kernel: k.kernel,
      parts: (h) => closure.get(h),
      access: (id) => id !== 'plate',
    });
    const r = await revoked.evaluate(request(assembly, 'r2'));
    expect(r.status === 'ok' && r.assembly!.versions[plate.contentHash]).toEqual({
      state: 'unavailable',
      code: 'part-access-revoked',
    });
    // The pair's own plate is still the same version: also revoked inside it, so it is not evaluated.
    expect(k.jobs.filter((j) => j.id.startsWith('r2/')).map((j) => j.hash)).not.toContain(
      plate.contentHash,
    );
    // The same content placed from another, readable Artifact is still evaluated once; each
    // occurrence's display checks its own Artifact.
    const twice = applyCadOperation(assembly, {
      type: 'insertComponents',
      parts: [
        {
          ...assembly.parts[0]!,
          id: 'part-plate-copy',
          source: {
            ...(assembly.parts[0]!.source as CadPartVersionSource),
            artifactId: 'plate-copy',
          },
        },
      ],
      components: [
        {
          ...assembly.components[0]!,
          id: 'c-copy',
          partId: 'part-plate-copy',
        },
      ],
    });
    const shared = await revoked.evaluate(request(twice, 'r3'));
    expect(shared.status === 'ok' && shared.assembly!.versions[plate.contentHash]).toMatchObject({
      state: 'available',
    });
    // A part of another build: a reference display when approved, unavailable otherwise.
    const v = fakeKernel({ substitute: otherBuild.kernelProfile.buildHash });
    const own = await v.kernel.evaluatePart(request(otherBuild), assembly.kernelProfile);
    expect(own.status === 'ok' && own.reference).toBe(true);
    const none = await fakeKernel().kernel.evaluatePart(
      request(otherBuild),
      assembly.kernelProfile,
    );
    expect(none.status === 'error' && none.code).toBe('part-build-mismatch');
  });

  it('makes the assembly a read-only reference while any part is a reference display', async () => {
    const earlier = `sha256:${'b'.repeat(64)}`;
    // Parts saved with an earlier build, placed in an assembly on the current one.
    const old = r2bParts({ id: fixtureKernel.id, buildHash: earlier });
    const assembly: CadDocument = {
      ...old.assembly,
      kernelProfile: { ...old.assembly.kernelProfile, buildHash: fixtureKernel.buildHash },
    };
    const port = new CadAssemblyPort({
      kernel: fakeKernel({ substitute: earlier }).kernel,
      parts: (h) => old.closure.get(h),
    });
    const shown = await port.evaluate(request(assembly));
    expect(shown.status === 'ok' && Object.values(shown.assembly!.versions)[0]!.state).toBe(
      'substitute',
    );
    expect(shown.status === 'ok' && shown.reference).toBe(true);
    // Its own build still evaluated the assembly: the display is not another build's.
    expect(shown.status === 'ok' && shown.buildHash).toBe(fixtureKernel.buildHash);
    const exact = await new CadAssemblyPort({
      kernel: fakeKernel().kernel,
      parts: (h) => r2bParts().closure.get(h),
    }).evaluate(request(r2bParts().assembly));
    expect(exact.status === 'ok' && exact.reference).toBeUndefined();
  });

  it('stops an older assembly between parts when a newer request or a cancel arrives', async () => {
    const { assembly, closure } = r2bParts();
    const k = fakeKernel({ hold: true });
    const port = new CadAssemblyPort({ kernel: k.kernel, parts: (h) => closure.get(h) });
    const older = port.evaluate(request(assembly, 'old'));
    k.held.shift()!(); // own document
    await Promise.resolve();
    await Promise.resolve();
    expect(port.partJobs.size).toBe(1);
    const newer = port.evaluate(request(assembly, 'new'));
    k.held.shift()!(); // the older run's first part
    const old = await older;
    expect(old.status === 'error' && old.code).toBe('superseded');
    // Its part result is kept: the newer run does not evaluate it again.
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 0));
      k.held.shift()?.();
    }
    const latest = await newer;
    expect(latest.status).toBe('ok');
    expect(port.partEvaluations).toBe(3);
    // Cancel: the waiting part job is cancelled with the request.
    const fresh = new CadAssemblyPort({ kernel: k.kernel, parts: (h) => closure.get(h) });
    const pending = fresh.evaluate(request(assembly, 'c'));
    k.held.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    fresh.cancel('c');
    expect(k.cancelled).toEqual(expect.arrayContaining(['c', expect.stringMatching(/^c\/part\//)]));
    k.held.shift()!();
    const done = await pending;
    expect(done.status === 'error' && done.code).toBe('cancelled');
  });
});
