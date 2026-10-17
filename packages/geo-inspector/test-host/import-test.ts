/** Volatile test Host only. No durable closure, storage API or source-free save bypass. */
import { EditorSession, EditorInputs } from '@editor-platform/editor-core';
import { contentHash } from '@editor-platform/artifact-core';
import { emptyGeo, assertGeo, type GeoDocument } from '@editor-platform/geo-core';
import { ReferenceRegistry, type Binding } from '@editor-platform/extension-runtime/draft2';
import { ManualClock } from '@editor-platform/extension-runtime/reference';
import { createControlledSurfaceController } from '@editor-platform/extension-runtime/controlled';
import type { DefinitionD2 } from '@editor-platform/extension-contract/draft2';
import { createSourceStaging } from './source-staging';
import { createImportWorkbench } from '../src/import-workbench/surface';
import { createFeatureTable } from '../src/feature-table';
import { createPointMap, preparePointScene } from '../src/point-map';
import { budgets, packageHash } from './fixture';
const limits = {
  native: { ...budgets, features: 400 },
  sourceBytes: 100_000,
  rows: 201,
  columns: 16,
  pendingPlans: 1,
};
const clock = new ManualClock(),
  registry = new ReferenceRegistry(clock),
  errors: string[] = [];
const binding: Binding<GeoDocument, never> = {
  artifactId: 'import-workbench',
  artifactKind: 'geo',
  schemaVersion: 1,
  session: new EditorSession(emptyGeo()),
  inputs: new EditorInputs(),
  allowed: () => true,
  subscribePermissions: () => () => {},
  recovery: {
    codecs: [],
    perBoundaryBytes: 2048,
    totalBytes: 8192,
    ttlMs: 1000,
    onRevoke: 'discard',
  },
};
const definition: DefinitionD2<GeoDocument, never> = {
  manifest: {
    id: 'test.geo-import-workbench',
    version: '0.0.0-experiment',
    packageHash,
    contractVersion: '1.0.0-draft.2',
    artifactKind: 'geo',
    schemaVersion: 1,
    surface: false,
    permissions: ['artifact:read', 'artifact:edit'],
    addons: {
      edit: { version: 'local-edit@0-draft', requirement: 'required' },
      inputs: { version: 'inputs@0-draft', requirement: 'required' },
      lifecycle: { version: 'lifecycle@0-draft', requirement: 'required' },
    },
    licenseNotices: [],
  },
  validate(value): value is GeoDocument {
    try {
      assertGeo(value, limits.native);
      return true;
    } catch {
      return false;
    }
  },
};
const installed = registry.install(definition, {
  trust: 'trusted',
  verifiedPin: definition.manifest,
});
const opened = installed.open(binding);
if (opened.state !== 'opened') throw new Error(opened.code);
const handle = opened.handle;
if (handle.context.addons.lifecycle.state !== 'granted') throw new Error('LifecycleRequired');
const editor = createControlledSurfaceController(handle.context, {
  onError: (e) => errors.push(String(e)),
});
const originals = new Map<string, Uint8Array>();
let stageGate: Promise<void> | undefined, finishStage: (() => void) | undefined;
const current = () => {
  handle.context.basic.read();
  return { revision: binding.session.revision, canEdit: true, budgets: limits.native };
};
const stages = createSourceStaging({ limit: 10, current, beforeHash: () => stageGate });
const output = document.querySelector<HTMLElement>('#imported')!;
let projections: { dispose(): void }[] = [];
function render() {
  if (
    handle.context.addons.lifecycle.state !== 'granted' ||
    handle.context.addons.lifecycle.api.signal.aborted
  )
    return;
  for (const p of projections) p.dispose();
  projections = [];
  output.replaceChildren();
  for (const layer of binding.session.content.layers) {
    const map = createPointMap(document, preparePointScene(layer), (id) => choose(id));
    const table = createFeatureTable(document, layer, (id) => choose(id));
    const choose = (id: string) => {
      map.select(id);
      table.select(id);
    };
    projections.push(map, table);
    output.append(map.element, table.element);
  }
}
const workbench = createImportWorkbench(
  document,
  {
    current,
    signal: handle.context.addons.lifecycle.api.signal,
    source: (bytes, name, format, signal) => stages.prepare(bytes, name, format, signal),
    commit(result, material) {
      const source = result.command.actions[0];
      if (source.type !== 'importLayer') throw new Error('ImportOnly');
      const staged = stages.ready(source.source.id);
      if (
        !staged ||
        staged.hash !== result.sourceBytesHash ||
        JSON.stringify(material.pin) !== JSON.stringify(staged.source.pin)
      )
        throw new Error('TestHostSourceMismatch');
      const view = editor.getSnapshot();
      if (view.state !== 'open') throw new Error('ImportScopeClosed');
      const next = result.editorCommand.apply(binding.session.content);
      // Test Host admission using the existing pinned draft.2 complete-view limits, before native write.
      const projected = {
        ...view,
        snapshot: {
          ...view.snapshot,
          content: next,
          revision: { ...view.snapshot.revision, sequence: view.snapshot.revision.sequence + 1 },
        },
        lastOperation: { state: 'applied' },
      };
      let nodes = 0;
      const check = (value: unknown, depth: number) => {
        if (++nodes > 4096 || depth > 24) throw new Error('ImportControlledCapacity');
        if (value && typeof value === 'object')
          for (const child of Object.values(value)) check(child, depth + 1);
      };
      check(projected, 0);
      if (new TextEncoder().encode(JSON.stringify(projected)).length > 65536)
        throw new Error('ImportControlledCapacity');
      if (originals.size >= 10) throw new Error('TestHostOriginalLimit');
      const bytes = material.bytes.slice();
      // Ephemeral allocation before native execution; no fallible storage operation after commit.
      originals.set(source.source.resourceId, bytes);
      const applied = editor.execute({
        baseRevision: { ...binding.session.revision },
        command: result.editorCommand,
      });
      if (applied.state !== 'applied') originals.delete(source.source.resourceId);
      else render();
      return applied;
    },
  },
  limits,
);
document.querySelector('#workbench')!.append(workbench.element);
document.querySelector<HTMLButtonElement>('#undo')!.onclick = () => {
  editor.undo();
  render();
};
document.querySelector<HTMLButtonElement>('#redo')!.onclick = () => {
  editor.redo();
  render();
};
const api = {
  /** Read-only evidence from retained bytes, not a durability or resource-resolution API. */
  async retainedHashes() {
    return Promise.all(
      [...originals].map(async ([resourceId, bytes]) => {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
        return {
          resourceId,
          bytesHash: `sha256:${Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('')}`,
        };
      }),
    );
  },
  async state() {
    return {
      content: binding.session.content,
      hash: await contentHash(binding.session.content),
      revision: binding.session.revision,
      canUndo: binding.session.canUndo,
      canRedo: binding.session.canRedo,
      retained: originals.size,
      staged: stages.size,
      errors,
    };
  },
  revoke() {
    handle.revoke('host-close');
    originals.clear();
    stages.dispose();
    for (const p of projections) p.dispose();
    output.replaceChildren();
  },
  holdSource() {
    stageGate = new Promise<void>((resolve) => {
      finishStage = resolve;
    });
  },
  releaseSource() {
    finishStage?.();
    stageGate = undefined;
  },
};
declare global {
  interface Window {
    geoImportTest: typeof api;
  }
}
window.geoImportTest = api;
