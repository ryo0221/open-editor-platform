import { f02Plate, type CadEvaluateRequest } from '@editor-platform/cad-core';
import { describe, expect, it } from 'vitest';
import { CatalogKernelPort, resolveKernelBuild, type CadKernelCatalog } from './catalog';
import type { WorkerLike } from './port';
import type { CadWorkerRequest, CadWorkerResponse } from './protocol';

const hash = (c: string) => `sha256:${c.repeat(64)}`;
const build = (c: string) => ({
  id: `kernel-${c}`,
  buildHash: hash(c),
  moduleUrl: `/${c}.js`,
  wasmUrl: `/${c}.wasm`,
});
const catalog: CadKernelCatalog = {
  current: build('c'),
  retained: [build('b')],
  revoked: [hash('d')],
  substitutes: [
    { from: hash('a'), to: hash('c'), semanticsVersion: 2 },
    { from: hash('d'), to: hash('c'), semanticsVersion: 2 },
    { from: hash('e'), to: hash('c'), semanticsVersion: 1 },
  ],
};
const profile = (c: string) => ({ buildHash: hash(c), semanticsVersion: 2 });

describe('resolveKernelBuild (CAD17)', () => {
  it('evaluates exactly with a served build, as a reference only through an approved substitute', () => {
    expect(resolveKernelBuild(catalog, profile('c'))).toMatchObject({ mode: 'exact' });
    expect(resolveKernelBuild(catalog, profile('b'))).toMatchObject({
      mode: 'exact',
      build: { id: 'kernel-b' },
    });
    expect(resolveKernelBuild(catalog, profile('a'))).toMatchObject({
      mode: 'reference',
      build: { buildHash: hash('c') },
      from: hash('a'),
    });
  });
  it('refuses revoked, unknown and other-semantics builds', () => {
    expect(resolveKernelBuild(catalog, profile('d'))).toEqual({
      mode: 'unavailable',
      code: 'kernel-build-revoked',
    });
    expect(resolveKernelBuild(catalog, profile('f'))).toEqual({
      mode: 'unavailable',
      code: 'kernel-build-unavailable',
    });
    expect(resolveKernelBuild(catalog, profile('e')).mode).toBe('unavailable');
    // A substitute that is itself revoked is no substitute.
    expect(resolveKernelBuild({ ...catalog, revoked: [hash('c')] }, profile('a')).mode).toBe(
      'unavailable',
    );
  });
});

function fakeWorkers() {
  const workers: (WorkerLike & { inbox: CadWorkerRequest[]; send(m: CadWorkerResponse): void })[] =
    [];
  const spawn = () => {
    const w = {
      inbox: [] as CadWorkerRequest[],
      onmessage: null as WorkerLike['onmessage'],
      onerror: null as WorkerLike['onerror'],
      postMessage(m: CadWorkerRequest) {
        this.inbox.push(m);
      },
      terminate() {},
      send(m: CadWorkerResponse) {
        this.onmessage?.({ data: m });
      },
    };
    workers.push(w);
    return w;
  };
  return { workers, spawn };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const request = (id: string, c: string): CadEvaluateRequest => {
  const document = f02Plate();
  document.kernelProfile.buildHash = hash(c);
  return { requestId: id, generation: 1, baseHash: 'x', candidateHash: 'x', document };
};

describe('CatalogKernelPort', () => {
  it('runs a reference evaluation on the substitute build and never exports it', async () => {
    const { workers, spawn } = fakeWorkers();
    const port = new CatalogKernelPort(catalog, { spawn });
    const pending = port.evaluate(request('r1', 'a'));
    const [worker] = workers;
    expect(worker.inbox[0]).toMatchObject({ type: 'init', build: { buildHash: hash('c') } });
    worker.send({ type: 'ready', buildHash: hash('c') });
    await flush();
    expect(worker.inbox[1]).toMatchObject({ type: 'evaluate', requestId: 'r1', reference: true });
    worker.send({
      type: 'result',
      requestId: 'r1',
      generation: 1,
      evaluation: {
        status: 'ok',
        contentHash: 'x',
        buildHash: hash('c'),
        geometryDigest: 'd',
        bodies: {},
        reference: true,
      },
      meshes: [],
    });
    expect(await pending).toMatchObject({ reference: true, buildHash: hash('c') });

    const exported = await port.exportMeshes(request('x1', 'a'), 0.01);
    expect(exported.evaluation).toMatchObject({ status: 'error', code: 'kernel-reference-only' });
    expect((await port.exportStep(request('x2', 'a'))).evaluation).toMatchObject({
      code: 'kernel-reference-only',
    });
    // STEP is read only by the document's exact build, which the imported feature names.
    expect(
      await port.importStep(request('x3', 'a').document.kernelProfile, 'x3', new Uint8Array(1)),
    ).toEqual({ status: 'rejected', code: 'kernel-reference-only' });
    expect(worker.inbox).toHaveLength(2);
    port.dispose();
  });
  it('keeps one Worker per build and starts none for a refused document', async () => {
    const { workers, spawn } = fakeWorkers();
    const port = new CatalogKernelPort(catalog, { spawn });
    expect(await port.evaluate(request('u1', 'f'))).toMatchObject({
      code: 'kernel-build-unavailable',
    });
    expect(await port.evaluate(request('u2', 'd'))).toMatchObject({ code: 'kernel-build-revoked' });
    expect(workers).toHaveLength(0);
    void port.evaluate(request('e1', 'b'));
    void port.evaluate(request('e2', 'c'));
    expect(
      workers.map((w) => (w.inbox[0] as { build: { buildHash: string } }).build.buildHash),
    ).toEqual([hash('b'), hash('c')]);
    // An exact evaluation carries no reference flag.
    workers[0].send({ type: 'ready', buildHash: hash('b') });
    await flush();
    expect(workers[0].inbox[1]).not.toHaveProperty('reference');
    port.dispose();
  });
  it('evaluates a part only with the assembly build, as a reference through a substitute (R2b-U6)', async () => {
    const { workers, spawn } = fakeWorkers();
    const port = new CatalogKernelPort(catalog, { spawn });
    // The part's own build b is retained, but an assembly of build c never starts a b Worker.
    expect(await port.evaluatePart(request('p1', 'b'), profile('c'))).toMatchObject({
      code: 'part-build-mismatch',
      retryable: false,
    });
    expect(await port.evaluatePart(request('p2', 'd'), profile('c'))).toMatchObject({
      code: 'kernel-build-revoked',
    });
    expect(await port.evaluatePart(request('p3', 'c'), profile('f'))).toMatchObject({
      code: 'kernel-build-unavailable',
    });
    expect(workers).toHaveLength(0);
    void port.evaluatePart(request('p4', 'a'), profile('c'));
    void port.evaluatePart(request('p5', 'c'), profile('c'));
    expect(workers).toHaveLength(1);
    workers[0].send({ type: 'ready', buildHash: hash('c') });
    await flush();
    // One Worker of the assembly's build: the other-build part as a reference, the same-build part exact.
    const sent = () =>
      workers[0].inbox.flatMap((m) =>
        m.type === 'evaluate' ? [[m.requestId, !!m.reference]] : [],
      );
    expect(sent()).toEqual([['p4', true]]);
    workers[0].send({
      type: 'result',
      requestId: 'p4',
      generation: 1,
      evaluation: {
        status: 'ok',
        contentHash: 'x',
        buildHash: hash('c'),
        geometryDigest: 'd',
        bodies: {},
        reference: true,
      },
      meshes: [],
    });
    await flush();
    expect(sent()).toEqual([
      ['p4', true],
      ['p5', false],
    ]);
    port.dispose();
  });
});
