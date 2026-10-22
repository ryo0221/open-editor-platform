import { EditorSession } from '@editor-platform/editor-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { f02Plate } from '@editor-platform/cad-core';
import type { WorkerLike } from '@editor-platform/cad-kernel-occt';
import { createCadBinding } from './binding';

afterEach(() => vi.unstubAllGlobals());

describe('createCadBinding', () => {
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
      build: { buildHash: `sha256:${'1'.repeat(64)}`, moduleUrl: './k.js', wasmUrl: './k.wasm' },
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
});
