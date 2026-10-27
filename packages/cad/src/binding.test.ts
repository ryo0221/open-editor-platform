import { EditorSession } from '@editor-platform/editor-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { f02Plate, fixtureKernel } from '@editor-platform/cad-core';
import { CatalogKernelPort, type WorkerLike } from '@editor-platform/cad-kernel-occt';
import { createCadBinding } from './binding';
import type { CadControllerOptions } from './controller';

afterEach(() => vi.unstubAllGlobals());

describe('createCadBinding', () => {
  it('gives the controller the kernel’s analyses on the exact build (R2a-4)', async () => {
    const binding = createCadBinding({
      session: new EditorSession(f02Plate()),
      build: null,
      spawnWorker: () => ({ postMessage() {}, terminate() {}, onmessage: null, onerror: null }),
      canEdit: () => true,
      permissionGeneration: () => 1,
    });
    const answer = { evaluation: { status: 'error', code: 'x', retryable: false } } as never;
    const continuity = vi
      .spyOn(CatalogKernelPort.prototype, 'analyzeContinuity')
      .mockResolvedValue(answer);
    const options = (binding.controller as unknown as { options: CadControllerOptions }).options;
    const request = { requestId: 'r' } as never;
    expect(await options.analyzeContinuity!(request, { bodyId: 'a', edge: 1 })).toBe(answer);
    expect(continuity).toHaveBeenCalledWith(request, { bodyId: 'a', edge: 1 });
    const curvature = vi
      .spyOn(CatalogKernelPort.prototype, 'analyzeCurvature')
      .mockResolvedValue(answer);
    const comb = vi.spyOn(CatalogKernelPort.prototype, 'analyzeComb').mockResolvedValue(answer);
    expect(await options.analyzeCurvature!(request)).toBe(answer);
    expect(curvature).toHaveBeenCalledWith(request);
    expect(await options.analyzeComb!(request, { bodyId: 'a', edge: 2 })).toBe(answer);
    expect(comb).toHaveBeenCalledWith(request, { bodyId: 'a', edge: 2 });
    vi.restoreAllMocks();
    binding.dispose();
  });

  it('resolves relative kernel URLs against the Host page before the Worker fetches them', () => {
    vi.stubGlobal('location', { href: 'https://host.example/app/editor.html' });
    const sent: unknown[] = [];
    const worker: WorkerLike = {
      postMessage: (message) => sent.push(message),
      terminate: () => {},
      onmessage: null,
      onerror: null,
    };
    const binding = createCadBinding({
      session: new EditorSession(f02Plate()),
      build: {
        id: 'k',
        buildHash: fixtureKernel.buildHash,
        moduleUrl: './k.js',
        wasmUrl: './k.wasm',
      },
      spawnWorker: () => worker,
      canEdit: () => true,
      permissionGeneration: () => 1,
    });
    void binding.controller.refresh();
    expect(sent[0]).toMatchObject({
      type: 'init',
      build: {
        moduleUrl: 'https://host.example/app/k.js',
        wasmUrl: 'https://host.example/app/k.wasm',
      },
    });
    binding.dispose();
  });

  it('a version save keeps the committed content while an edit evaluates; leaving waits (ST-28 #6, CAD21)', () => {
    // A Worker that never answers: every edit stays evaluating.
    const worker: WorkerLike = {
      postMessage: () => {},
      terminate: () => {},
      onmessage: null,
      onerror: null,
    };
    const session = new EditorSession(f02Plate());
    const binding = createCadBinding({
      session,
      build: null,
      spawnWorker: () => worker,
      canEdit: () => true,
      permissionGeneration: () => 1,
    });
    const committed = session.content;
    const width = committed.parameters[0];
    void binding.controller.run({ type: 'setParameter', parameterId: width.id, value: 100 });
    expect(binding.controller.getSnapshot().busy).toBe(true);
    // Switching, exporting or leaving the editor would drop the candidate: refused.
    expect(() => binding.flushInputs()).toThrow('形状を計算中');
    // A save that keeps the editor open captures the committed content, without the candidate.
    expect(() => binding.flushInputs({ keepEditor: true })).not.toThrow();
    expect(session.content.parameters[0].value).toBe(width.value);
    expect(session.content).toEqual(committed);
    expect(binding.inputs.getSnapshot()).toMatchObject({ dirty: 0, settling: 1 });

    // A field that the save itself commits starts the user's latest edit: that save waits.
    let typed = true;
    const stop = binding.inputs.register({
      label: 'Width',
      read: () => ({ dirty: typed }),
      prepare: () => () => {
        typed = false;
        void binding.controller.run({ type: 'setParameter', parameterId: width.id, value: 120 });
      },
      focus: () => {},
    });
    expect(() => binding.flushInputs({ keepEditor: true })).toThrow('形状を計算中');
    stop();
    binding.dispose();
  });
});
