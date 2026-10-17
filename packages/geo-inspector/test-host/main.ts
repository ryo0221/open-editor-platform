// Source-bound independent Host. Package activation/public export is owned by #76.
import { contentHash } from '@editor-platform/artifact-core';
import { command } from '@editor-platform/editor-core';
import { ReferenceRegistry } from '@editor-platform/extension-runtime/draft2';
import { ManualClock } from '@editor-platform/extension-runtime/reference';
import type { HandleD2 } from '@editor-platform/extension-contract/draft2';
import type { GeoDocument } from '@editor-platform/geo-core';
import {
  geoInspectorExtension,
  type GeoInspectorMount,
  type InspectorTestGates,
} from '../src/index';
import { budgets, fixture, nativeBinding, packageHash } from './fixture';
import { pointFixture, type FixtureKind } from './point-fixture';
type Mode =
  | 'ready'
  | 'beforePrepare'
  | 'beforeMount'
  | 'afterMount'
  | 'afterDispose'
  | 'failDispose'
  | 'oversize';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const container = document.querySelector<HTMLElement>('#surface')!;
const status = document.querySelector<HTMLElement>('#status')!;
const clock = new ManualClock();
let serial = 0;
const runs = new Map<
  number,
  {
    handle: HandleD2<GeoDocument, never>;
    host: ReturnType<typeof nativeBinding>;
    mount?: GeoInspectorMount;
    gate: ReturnType<typeof deferred>;
    state: string;
    error?: string;
    phase: string;
  }
>();
let currentId = 0;
function open(mode: Mode = 'ready', data: FixtureKind = 'points') {
  sessionStorage.removeItem('geo-read-denied');
  runs.get(currentId)?.handle.revoke('replace');
  const id = ++serial;
  currentId = id;
  const gate = deferred();
  const content = data === 'legacy' ? fixture() : pointFixture(data);
  if (mode === 'oversize') content.layers[0].name = 'x'.repeat(65536);
  const host = nativeBinding(content, `synthetic-geo-${id}`);
  const gates: InspectorTestGates = {};
  const wait = async () => {
    runs.get(id)!.phase = mode;
    await gate.promise;
  };
  if (
    mode === 'beforePrepare' ||
    mode === 'beforeMount' ||
    mode === 'afterMount' ||
    mode === 'afterDispose'
  )
    gates[mode] = wait;
  if (mode === 'failDispose')
    gates.afterDispose = () => {
      throw new Error('SyntheticDisposeFailure');
    };
  const definition = geoInspectorExtension(packageHash, budgets, {
    gates,
    observe(mount) {
      const run = runs.get(id)!;
      run.mount = mount;
      void mount.ready.then(
        () => {
          run.state = 'ready';
          if (currentId === id) status.textContent = 'Ready: fixed native capture';
        },
        (error) => {
          run.state = 'rejected';
          run.error = error instanceof Error ? error.message : String(error);
          if (currentId === id)
            status.textContent = `Inspector refused: ${run.error}. Native data retained.`;
        },
      );
    },
  });
  const registry = new ReferenceRegistry(clock);
  const installed = registry.install(definition, {
    trust: 'trusted',
    verifiedPin: definition.manifest,
  });
  const opened = installed.open(host.binding);
  if (opened.state !== 'opened') throw new Error(opened.code);
  runs.set(id, { handle: opened.handle, host, gate, state: 'pending', phase: 'start' });
  status.textContent = 'Preparing fixed native capture';
  opened.handle.mount(container);
  return id;
}
const api = {
  open,
  instance: crypto.randomUUID(),
  release(id: number) {
    runs.get(id)!.gate.resolve();
  },
  revoke(id: number) {
    sessionStorage.setItem('geo-read-denied', 'true');
    runs.get(id)!.host.revokeRead();
  },
  async drain(id: number) {
    const result = runs.get(id)!.handle.drain({ deadlineMs: clock.now() });
    return result;
  },
  change(id: number) {
    const session = runs.get(id)!.host.binding.session;
    session.execute(
      command<GeoDocument>('host-change', 'Test Host changes native', (v) => ({
        ...v,
        layers: v.layers.map((l) => ({ ...l, name: 'Host changed' })),
      })),
    );
  },
  async state(id: number) {
    const run = runs.get(id)!;
    const session = run.host.binding.session;
    return {
      id,
      state: run.state,
      error: run.error,
      phase: run.phase,
      json: JSON.stringify(session.content),
      hash: await contentHash(session.content),
      revision: session.revision,
      canUndo: session.canUndo,
      canRedo: session.canRedo,
      listeners: run.host.listeners(),
      surfaces: container.childElementCount,
    };
  },
};
declare global {
  interface Window {
    geoInspectorTest: typeof api;
  }
}
window.geoInspectorTest = api;
// Package-local test Host mirrors the accepted page lifecycle; no shared Host changes.
addEventListener('pagehide', () => runs.get(currentId)?.handle.revoke('host-close'));
addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});
if (sessionStorage.getItem('geo-read-denied')) status.textContent = 'Read permission denied';
else open();
