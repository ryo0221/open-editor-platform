/** Host-private source-backed persistence experiment; not a source-free editor bypass. */
import { EditorSession, EditorInputs } from '@editor-platform/editor-core';
import { contentHash } from '@editor-platform/artifact-core';
import { emptyGeo, assertGeo, type GeoDocument } from '@editor-platform/geo-core';
import { ReferenceRegistry, type Binding } from '@editor-platform/extension-runtime/draft2';
import { ManualClock } from '@editor-platform/extension-runtime/reference';
import { createControlledSurfaceController } from '@editor-platform/extension-runtime/controlled';
import type {
  DefinitionD2,
  HandleD2,
  LocalReadSnapshot,
} from '@editor-platform/extension-contract/draft2';
import type { ControlledSurfaceController } from '@editor-platform/extension-contract/controlled-surface';
import { createImportWorkbench } from '@editor-platform/geo-inspector/import-experiment';
import { pointEditPort } from '@editor-platform/geo-inspector/point-edit';
import { createGeoWorkspaceSurface } from '@editor-platform/geo-inspector/import-experiment';
import { createGeoWorkspaceHost } from './geo-workspace';
import { geoSlideImageArtifact } from './geo-slide-transfer';
import { createSourceProfile } from './geo-source-profile';
import { mountSavedGeoExport } from './geo-data-export';
import { assertGeoSaveCapacity } from '@editor-platform/geo-inspector/point-save';
import { GeoSourceStorage, assertSourceCaptureCapacity } from './geo-source-adapter';
import {
  sourceBudgets,
  sourceLimits,
  originalHash,
  type SourceClosure,
  type GeoSourceEnvelope,
} from './geo-source-envelope';
declare const EDITOR_PINS: Record<string, string>;
const packageHash = EDITOR_PINS['@editor-platform/geo-inspector'];
const artifactId = 'reference-geo-source-save';
const policyKey = artifactId + '-readonly';
let authorized = sessionStorage.getItem(policyKey) !== 'readonly';
const clock = new ManualClock(),
  registry = new ReferenceRegistry(clock),
  errors: string[] = [];
const permissionListeners = new Set<() => void>();
const root = document.querySelector('main')!;
root.className = 'geo-source-host';
root.innerHTML =
  '<section aria-label="Source persistence"><button id="save">Save original + native</button><button id="reopen">Reopen latest</button><label>Retained version<select id="versions" aria-label="Retained version"></select></label><button id="reopen-version">Reopen selected version</button><button id="revoke">Close edit scope</button><p role="status" aria-label="Source save status"></p><p>Maximum 200 features, subject to the complete 64KiB native budget; originals total 100,000 bytes. Each encoded record: 256KiB. Retained: 16 versions / 4MiB. Old versions are never automatically deleted.</p><p id="retention"></p></section><div id="workbench"></div><button id="undo">Undo last change</button><button id="redo">Redo last change</button><div id="imported"></div><div id="data-export"></div>';
const style = document.createElement('style');
style.textContent =
  '.geo-source-host{max-width:100%;overflow-wrap:anywhere}.geo-source-host label{display:block;margin:8px 0}.geo-source-host input:not([type=checkbox]),.geo-source-host select{display:block;width:100%;max-width:100%;box-sizing:border-box;padding:8px}.geo-source-host fieldset{min-width:0}.geo-source-host svg{max-width:100%;height:auto}.geo-source-host button{margin:4px;padding:8px}';
root.prepend(style);
const status = root.querySelector<HTMLElement>('[role=status]')!;
const saveButton = root.querySelector<HTMLButtonElement>('#save')!;
const reopenButton = root.querySelector<HTMLButtonElement>('#reopen')!;
const versionButton = root.querySelector<HTMLButtonElement>('#reopen-version')!;
const versions = root.querySelector<HTMLSelectElement>('#versions')!;
// Track user intent in the Host-owned import region without inspecting domain buffers.
// Pre-existing drafts may be replaced by explicit Reopen; input arriving after it starts may not.
const workbenchRegion = root.querySelector<HTMLElement>('#workbench')!;
let workbenchEpoch = 0;
for (const event of ['input', 'change', 'click', 'compositionstart', 'compositionend'])
  workbenchRegion.addEventListener(
    event,
    () => {
      workbenchEpoch++;
      exportOutput?.retire();
    },
    true,
  );
const composing = new Set<EventTarget>();
root.addEventListener(
  'compositionstart',
  (event) => {
    if (event.target) composing.add(event.target);
    renderSave();
  },
  true,
);
root.addEventListener(
  'compositionend',
  (event) => {
    if (event.target) composing.delete(event.target);
    renderSave();
  },
  true,
);
let binding: Binding<GeoDocument, never>;
let handle: HandleD2<GeoDocument, never>;
let editor: ControlledSurfaceController<GeoDocument>;
let originals = new Map<string, SourceClosure>();
let nextSource = 0,
  savingOperations = 0,
  opening = false,
  pageClosed = false;
let settlementTimer: ReturnType<typeof setTimeout> | undefined;
let pointPort: ReturnType<typeof pointEditPort>;
let pointSurface: ReturnType<typeof createGeoWorkspaceSurface> | undefined;
let sourceProfile: ReturnType<typeof createSourceProfile>;
let fromSaved: { generation: string; sessionId: string; sequence: number } | undefined;
let disposeWorkbench: (() => void) | undefined;
let stopObserving: (() => void) | undefined;
let exportOutput: ReturnType<typeof mountSavedGeoExport> | undefined;
versions.addEventListener('change', () => exportOutput?.retire());
const limits = {
  native: { ...sourceBudgets, bytes: 2_000_000, depth: 32, features: 400, vertices: 2000 },
  sourceBytes: sourceLimits.originals,
  rows: 201,
  columns: 16,
  pendingPlans: 1,
};
function assertCurrent(snapshot?: LocalReadSnapshot<GeoDocument>) {
  if (pageClosed) throw Error('GeoPageClosed');
  // Read permission survives explicit edit revocation; no reopening operation grants edit.
  if (!snapshot) return;
  const view = editor?.getSnapshot();
  if (!authorized || view?.state !== 'open' || !view.canEdit) throw Error('GeoAuthorityChanged');
  if (
    view.snapshot.scope.generation !== snapshot.scope.generation ||
    view.snapshot.revision.sessionId !== snapshot.revision.sessionId ||
    view.snapshot.revision.sequence !== snapshot.revision.sequence
  )
    throw Error('GeoSaveConflict');
  const input = binding.inputs.getSnapshot();
  if (input.dirty || input.composing || composing.size) throw Error('GeoPendingInputs');
}
const storage = new GeoSourceStorage({
  key: artifactId,
  databaseName: artifactId + '-v1',
  current: assertCurrent,
  closure(content) {
    return content.sources.map((source) => {
      const material = originals.get(source.resourceId);
      if (
        !material ||
        material.sourceId !== source.id ||
        JSON.stringify(material.pin) !== JSON.stringify(source.pin)
      )
        throw Error('GeoSourceMissing');
      return structuredClone(material);
    });
  },
});
const definition: DefinitionD2<GeoDocument, never> = {
  manifest: {
    id: 'example.geo-source-save',
    version: '0.0.0-experiment',
    packageHash,
    contractVersion: '1.0.0-draft.2',
    artifactKind: 'geo',
    schemaVersion: 1,
    surface: false,
    permissions: ['artifact:read', 'artifact:edit', 'artifact:save'],
    addons: {
      edit: { version: 'local-edit@0-draft', requirement: 'optional' },
      inputs: { version: 'inputs@0-draft', requirement: 'optional' },
      save: { version: 'local-persistence@0-draft', requirement: 'optional' },
      lifecycle: { version: 'lifecycle@0-draft', requirement: 'required' },
    },
    licenseNotices: [],
  },
  validate(value): value is GeoDocument {
    try {
      assertGeo(value, sourceBudgets);
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
function savePending() {
  const view = editor?.getSnapshot();
  return (
    savingOperations > 0 ||
    (view?.state === 'open' && view.saving) ||
    registry.saves
      .observations()
      .some((job) => !job.outcome || job.outcome.state === 'indeterminate')
  );
}
function renderSave() {
  if (pageClosed || !editor) return;
  clearTimeout(settlementTimer);
  const view = editor.getSnapshot(),
    pending = savePending();
  reopenButton.disabled = versionButton.disabled = pending || opening;
  saveButton.disabled =
    view.state !== 'open' || !view.canSave || view.saving || opening || composing.size > 0;
  for (const id of ['undo', 'redo'])
    root.querySelector<HTMLButtonElement>('#' + id)!.disabled =
      !authorized ||
      view.state !== 'open' ||
      !sourceProfile?.checkHistory() ||
      (id === 'undo' ? !binding.session.canUndo : !binding.session.canRedo);
  if (pending) settlementTimer = setTimeout(renderSave, 100);
  if (view.state !== 'open') {
    status.textContent = 'Scope revoked';
    return;
  }
  if (view.saving) {
    status.textContent = 'Saving captured native and complete originals';
    return;
  }
  const last = view.lastSave;
  if (!last) {
    const restored =
      fromSaved?.generation === view.snapshot.scope.generation &&
      fromSaved.sessionId === view.snapshot.revision.sessionId &&
      fromSaved.sequence === view.snapshot.revision.sequence;
    status.textContent = restored ? 'Restored saved version' : 'Unsaved local draft';
    return;
  }
  const current =
    last.capture.scope.generation === view.snapshot.scope.generation &&
    last.capture.revision.sessionId === view.snapshot.revision.sessionId &&
    last.capture.revision.sequence === view.snapshot.revision.sequence;
  status.textContent =
    last.state === 'committed'
      ? current
        ? 'Saved current capture and originals'
        : 'Older capture saved; current draft unsaved'
      : last.state === 'indeterminate'
        ? 'Indeterminate; reconcile before retry'
        : 'No write; ' + (storage.lastCode ?? 'retry available');
}
async function refreshVersions() {
  const index = await storage.inspect();
  if (pageClosed) return;
  const selected = versions.value;
  versions.replaceChildren(
    ...index.versionIds.map((id) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = id + (id === index.head ? ' (latest)' : '');
      return option;
    }),
  );
  if (index.versionIds.includes(selected)) versions.value = selected;
  root.querySelector('#retention')!.textContent =
    `Retained ${index.versions} / 16 versions; ${index.bytes} / 4194304 bytes. No automatic deletion.`;
}
function installContent(content: GeoDocument, closure: SourceClosure[], restored = false) {
  assertGeo(content, sourceBudgets);
  const nextBinding: Binding<GeoDocument, never> = {
    artifactId,
    artifactKind: 'geo',
    schemaVersion: 1,
    session: new EditorSession(content),
    inputs: new EditorInputs(),
    storage,
    allowed: (grant) =>
      grant === 'artifact:read' ||
      (authorized && (grant === 'artifact:edit' || grant === 'artifact:save')),
    subscribePermissions(listener) {
      permissionListeners.add(listener);
      return () => {
        permissionListeners.delete(listener);
      };
    },
    recovery: {
      codecs: [],
      perBoundaryBytes: 2048,
      totalBytes: 8192,
      ttlMs: 1000,
      onRevoke: 'discard',
    },
  };
  assertGeoSaveCapacity({
    scope: {
      artifactId,
      sessionId: nextBinding.session.revision.sessionId,
      generation: '0'.repeat(36),
    },
    revision: nextBinding.session.revision,
    content,
  });
  const result = installed.open(nextBinding);
  if (result.state !== 'opened') throw Error(result.code);
  const nextHandle = result.handle;
  if (nextHandle.context.addons.lifecycle.state !== 'granted') throw Error('LifecycleRequired');
  const nextEditor = createControlledSurfaceController(nextHandle.context, {
    onError: (error) => errors.push(String(error)),
  });
  const ownedOriginals = new Map(
    closure.map((entry) => [entry.resourceId, structuredClone(entry)]),
  );
  const nextProfile = createSourceProfile({
    originals: ownedOriginals,
    allowManualFeatures: true,
    current() {
      if (nextHandle.context.addons.lifecycle.state !== 'granted') throw Error('LifecycleRequired');
      nextHandle.context.addons.lifecycle.api.assertCurrent();
    },
  });
  let nextSurface: ReturnType<typeof createGeoWorkspaceSurface>;
  let exportEpoch = 0;
  const capacity = (snapshot: LocalReadSnapshot<GeoDocument>, next: GeoDocument) => {
    assertGeoSaveCapacity(snapshot, next);
    const retained = next.sources.map((source) => {
      const entry = ownedOriginals.get(source.resourceId);
      if (
        !entry ||
        entry.sourceId !== source.id ||
        JSON.stringify(entry.pin) !== JSON.stringify(source.pin)
      )
        throw Error('GeoSourceMissing');
      return entry;
    });
    assertSourceCaptureCapacity({ ...snapshot, content: next }, retained);
  };
  const nextPort = pointEditPort(
    nextHandle.context,
    nextEditor,
    sourceBudgets,
    (snapshot, next) => {
      assertGeoSaveCapacity(snapshot, next);
      const retained = next.sources.map((source) => {
        const entry = ownedOriginals.get(source.resourceId);
        if (
          !entry ||
          entry.sourceId !== source.id ||
          JSON.stringify(entry.pin) !== JSON.stringify(source.pin)
        )
          throw Error('GeoSourceMissing');
        return entry;
      });
      assertSourceCaptureCapacity({ ...snapshot, content: next }, retained);
    },
    nextProfile.profile,
  );
  try {
    nextProfile.adopt(content);
    nextSurface = createGeoWorkspaceSurface(
      document,
      nextEditor,
      createGeoWorkspaceHost({
        artifactId,
        sourceId: () => `source-${++nextSource}`,
        context: nextHandle.context,
        editor: nextEditor,
        storage,
        originals: ownedOriginals,
        profile: nextProfile,
        versionId: () => versions.value,
        stamp: exportStamp,
        inputChanged() {
          exportEpoch++;
          workbenchEpoch++;
        },
        capacity,
        async placeOnSlide(bundle) {
          const stamp = exportStamp(),
            artifact = await geoSlideImageArtifact(bundle);
          if (exportStamp() !== stamp) throw Error('Slide transfer changed');
          return artifact;
        },
      }),
    );
  } catch (error) {
    nextHandle.revoke('host-close');
    throw error;
  }
  stopObserving?.();
  disposeWorkbench?.();
  exportOutput?.dispose();
  pointSurface?.dispose();
  handle?.revoke('host-close');
  handle = nextHandle;
  editor = nextEditor;
  binding = nextBinding;
  composing.clear();
  originals = ownedOriginals;
  pointPort = nextPort;
  pointSurface = nextSurface;
  sourceProfile = nextProfile;
  const installedView = nextEditor.getSnapshot();
  fromSaved =
    restored && installedView.state === 'open'
      ? {
          generation: installedView.snapshot.scope.generation,
          sessionId: installedView.snapshot.revision.sessionId,
          sequence: installedView.snapshot.revision.sequence,
        }
      : undefined;
  root.querySelector('#imported')!.replaceChildren(nextSurface.element);
  for (const entry of closure) {
    const match = /^source-(\d+)$/.exec(entry.sourceId);
    if (match) nextSource = Math.max(nextSource, Number(match[1]));
  }
  const stage = new Map<string, SourceClosure>();
  const signal = nextHandle.context.addons.lifecycle.api.signal;
  const current = () => {
    nextHandle.context.basic.read();
    if (handle !== nextHandle || signal.aborted) throw Error('ImportScopeClosed');
    return { revision: binding.session.revision, canEdit: authorized, budgets: limits.native };
  };
  const workbench = authorized
    ? createImportWorkbench(
        document,
        {
          signal,
          current,
          importedNotice:
            'Complete originals retained. Use Save original + native to persist this capture.',
          async source(bytes, name, format, caller) {
            current();
            if (name.length === 0 || name.length > 128) throw Error('SourceManifestName');
            if (caller.aborted || stage.size >= sourceLimits.sources)
              throw Error('SourceStageLimit');
            if (!Number.isSafeInteger(nextSource + 1)) throw Error('SourceStageIdLimit');
            const sourceId = `source-${++nextSource}`,
              resourceId = `resource-${sourceId}`;
            // Reservation precedes every await; old releases cannot delete newer reservations.
            const reservation = {} as SourceClosure;
            stage.set(sourceId, reservation);
            const release = () => {
              if (stage.get(sourceId) === reservation) stage.delete(sourceId);
              caller.removeEventListener('abort', release);
            };
            caller.addEventListener('abort', release, { once: true });
            const check = () => {
              current();
              if (caller.aborted || stage.get(sourceId) !== reservation)
                throw Error('SourceStageReleased');
            };
            try {
              const owned = bytes.slice(),
                bytesHash = await originalHash(owned);
              check();
              const manifest = {
                schemaVersion: 1 as const,
                name,
                format,
                byteLength: owned.length,
                bytesHash,
              };
              const hash = await contentHash(manifest);
              check();
              const versionId = crypto.randomUUID();
              const pin = { artifactId: sourceId, versionId, contentHash: 'sha256:' + hash };
              const sourceVersion = {
                artifactId: sourceId,
                versionId,
                parentVersionId: null,
                schemaVersion: 1,
                contentHash: hash,
                createdAt: new Date().toISOString(),
                createdBy: null,
                reason: 'Local import',
                content: manifest,
              };
              let binary = '';
              for (const byte of owned) binary += String.fromCharCode(byte);
              Object.assign(reservation, {
                sourceId,
                resourceId,
                pin,
                sourceVersion,
                recipe: {},
                encoding: 'base64',
                bytes: btoa(binary),
              });
              return {
                source: {
                  id: sourceId,
                  resourceId,
                  pin,
                  attribution: 'User-selected local file; original retained by Host.',
                },
                release,
              };
            } catch (error) {
              release();
              throw error;
            }
          },
          commit(result, material) {
            current();
            const source = result.command.actions[0];
            if (source.type !== 'importLayer') throw Error('ImportOnly');
            const entry = stage.get(source.source.id);
            if (
              !entry ||
              entry.sourceVersion.content.bytesHash !== result.sourceBytesHash ||
              JSON.stringify(entry.pin) !== JSON.stringify(material.pin)
            )
              throw Error('GeoSourceMismatch');
            const view = editor.getSnapshot();
            if (view.state !== 'open') throw Error('ImportScopeClosed');
            const next = result.editorCommand.apply(binding.session.content);
            assertGeo(next, sourceBudgets);
            assertGeoSaveCapacity(view.snapshot, next);
            if (ownedOriginals.size >= sourceLimits.sources) throw Error('GeoOriginalLimit');
            const total =
              [...ownedOriginals.values()].reduce(
                (sum, value) => sum + value.sourceVersion.content.byteLength,
                0,
              ) + entry.sourceVersion.content.byteLength;
            if (total > sourceLimits.originals) throw Error('GeoOriginalBytesLimit');
            const captured = structuredClone({ ...entry, recipe: material.recipe });
            const closure = next.sources.map((nextSource) => {
              const retained =
                nextSource.resourceId === captured.resourceId
                  ? captured
                  : ownedOriginals.get(nextSource.resourceId);
              if (
                !retained ||
                retained.sourceId !== nextSource.id ||
                JSON.stringify(retained.pin) !== JSON.stringify(nextSource.pin)
              )
                throw Error('GeoSourceMissing');
              return retained;
            });
            assertSourceCaptureCapacity({ ...view.snapshot, content: next }, closure);
            ownedOriginals.set(entry.resourceId, captured);
            let rollback: (() => void) | undefined;
            try {
              rollback = nextProfile.adopt(next);
              const applied = editor.execute({
                baseRevision: { ...binding.session.revision },
                command: result.editorCommand,
              });
              if (applied.state !== 'applied') {
                rollback();
                ownedOriginals.delete(entry.resourceId);
              }
              renderSave();
              return applied;
            } catch (error) {
              rollback?.();
              ownedOriginals.delete(entry.resourceId);
              throw error;
            }
          },
        },
        limits,
      )
    : undefined;
  const mount = root.querySelector('#workbench')!;
  mount.replaceChildren();
  if (workbench) mount.append(workbench.element);
  else
    mount.textContent = 'Read-only source capture. Import and editing permission remains closed.';
  disposeWorkbench = () => {
    workbench?.dispose();
    stage.clear();
  };
  signal.addEventListener(
    'abort',
    () => {
      nextSurface.dispose();
      ownedOriginals.clear();
      stage.clear();
      workbench?.dispose();
      composing.clear();
    },
    { once: true },
  );
  function exportStamp() {
    nextHandle.context.basic.read();
    if (pageClosed || signal.aborted || handle !== nextHandle || !authorized)
      throw Error('GeoExportScopeClosed');
    if (opening || savePending()) throw Error('GeoSavePending');
    const view = nextEditor.getSnapshot();
    if (view.state !== 'open') throw Error('GeoExportScopeClosed');
    const input = nextBinding.inputs.getSnapshot();
    if (input.dirty || input.composing || composing.size) throw Error('GeoPendingInputs');
    return JSON.stringify([
      view.snapshot.scope,
      view.snapshot.revision,
      workbenchEpoch,
      versions.value,
      exportEpoch,
    ]);
  }
  const dataOutput = mountSavedGeoExport(document, {
    artifactId,
    signal,
    versionId: () => versions.value,
    stamp: exportStamp,
    flush() {
      if (!authorized || handle !== nextHandle || signal.aborted || pageClosed)
        throw Error('GeoExportScopeClosed');
      if (opening || savePending()) throw Error('GeoSavePending');
      if (composing.size) throw Error('GeoPendingInputs');
      const result = nextEditor.applyInputs();
      if (result.state === 'refused') throw Error(result.code + ': ' + result.message);
      exportStamp();
    },
    read: async (versionId) => (await storage.read(versionId)).record,
  });
  exportOutput = {
    element: dataOutput.element,
    retire() {
      exportEpoch++;
      dataOutput.retire();
      nextSurface.retire();
    },
    dispose() {
      exportEpoch++;
      dataOutput.dispose();
      nextSurface.retire();
    },
  };
  root.querySelector('#data-export')!.replaceChildren(exportOutput.element);
  const output = exportOutput;
  const stopEditor = nextEditor.subscribe(() => {
    renderSave();
    output.retire();
  });
  // Pending Point buffers do not publish a new native revision. Revoke the URL
  // itself so copied links/context-menu downloads cannot bypass the click guard.
  const stopInputs = nextBinding.inputs.subscribe(() => {
    output.retire();
  });
  const stopScopeObservers = () => {
    stopEditor();
    stopInputs();
    signal.removeEventListener('abort', stopScopeObservers);
  };
  stopObserving = stopScopeObservers;
  signal.addEventListener('abort', stopScopeObservers, { once: true });
  renderSave();
}
async function save() {
  if (opening) throw Error('GeoOpenBusy');
  const capturedEditor = editor;
  savingOperations++;
  renderSave();
  let result;
  try {
    result = await capturedEditor.save();
  } finally {
    savingOperations--;
    renderSave();
    await refreshVersions().catch((error) => {
      status.textContent = String(error);
    });
  }
  if (capturedEditor === editor && result.state === 'refused')
    status.textContent = result.code + ': ' + result.message;
  return result;
}
async function reopen(versionId?: string, text?: string) {
  if (opening) throw Error('GeoOpenBusy');
  if (savePending()) throw Error('GeoSavePending');
  const previousHandle = handle,
    previousWorkbenchEpoch = workbenchEpoch,
    revision = binding.session.revision,
    authority = authorized;
  const pendingInputs = () => {
    const input = binding.inputs.getSnapshot();
    return input.dirty || input.composing || composing.size > 0;
  };
  if (pendingInputs()) throw Error('GeoPendingInputs');
  opening = true;
  // Reopening suspends export authority before storage.read can yield.
  exportOutput?.retire();
  renderSave();
  try {
    const loaded = text === undefined ? await storage.read(versionId) : undefined;
    const record = text === undefined ? loaded?.record : await storage.checked(text);
    if (!record) throw Error('GeoNoSavedCapture');
    if (
      previousHandle !== handle ||
      authority !== authorized ||
      pageClosed ||
      revision.sessionId !== binding.session.revision.sessionId ||
      revision.sequence !== binding.session.revision.sequence
    )
      throw Error('GeoReopenConflict');
    if (pendingInputs()) throw Error('GeoPendingInputs');
    if (previousWorkbenchEpoch !== workbenchEpoch) throw Error('GeoReopenConflict');
    installContent(record.request.content, record.closure, true);
    if (loaded) storage.head = loaded.head;
    status.textContent = 'Reopened acknowledged native and complete originals';
    await refreshVersions();
  } finally {
    opening = false;
    const notice = status.textContent;
    renderSave();
    status.textContent = notice;
  }
}
const host = {
  async state() {
    return {
      content: binding.session.content,
      hash: await contentHash(binding.session.content),
      revision: binding.session.revision,
      canUndo: binding.session.canUndo,
      canRedo: binding.session.canRedo,
      inputs: binding.inputs.getSnapshot(),
      view: editor.getSnapshot(),
      errors,
      retained: storage.retained,
      originals: [...originals.values()].map((entry) => ({
        resourceId: entry.resourceId,
        byteLength: entry.sourceVersion.content.byteLength,
        hash: entry.sourceVersion.content.bytesHash,
      })),
      saved: storage.saved,
      writes: storage.writes,
      head: storage.head,
      policy: authorized ? 'editable' : 'readonly',
      observations: registry.saves.observations(),
      lastCode: storage.lastCode,
    };
  },
  // Fault injection for the installed verification harness; never a user action.
  loseOriginal: (resourceId: string) => originals.delete(resourceId),
  save,
  reopen,
  reopenText: (text: string) => reopen(undefined, text),
  load: async (versionId?: string) => (await storage.read(versionId)).record,
  retained: () => storage.inspect(),
  raw: () => storage.raw(),
  storageMode: (mode: typeof storage.mode) => {
    storage.mode = mode;
  },
  pauseBefore: () => {
    storage.pauseBefore = true;
  },
  releaseBefore: () => {
    storage.pauseBefore = false;
    storage.pendingBefore?.();
    storage.pendingBefore = undefined;
  },
  release: () => {
    storage.pending?.();
    storage.pending = undefined;
  },
  expireSave: () => clock.advanceTo(clock.now() + storage.settlementMs),
  reconcile() {
    const evidence = storage.lastEvidence;
    if (!evidence || evidence.state !== 'committed') throw Error('NoEvidence');
    registry.saves.reconcile(evidence.operationId, evidence);
    renderSave();
  },
  revoke() {
    authorized = false;
    sessionStorage.setItem(policyKey, 'readonly');
    for (const listener of [...permissionListeners]) listener();
    handle.revoke('host-close');
    renderSave();
  },
  undo() {
    if (!sourceProfile.checkHistory())
      return { state: 'refused', code: 'GeoHistoryRefused', message: 'GeoSourceClosureRequired' };
    const result = pointPort.undo();
    renderSave();
    return result;
  },
  redo() {
    if (!sourceProfile.checkHistory())
      return { state: 'refused', code: 'GeoHistoryRefused', message: 'GeoSourceClosureRequired' };
    const result = pointPort.redo();
    renderSave();
    return result;
  },
};
for (const id of ['save', 'reopen', 'reopen-version'])
  root.querySelector<HTMLButtonElement>('#' + id)!.onclick = () => {
    void (
      id === 'save' ? save() : reopen(id === 'reopen-version' ? versions.value : undefined)
    ).catch((error) => {
      if (id !== 'save' && error instanceof Error && error.message === 'GeoPendingInputs') {
        const input = binding.inputs.getSnapshot();
        const guidance =
          'Your input is still kept. To preserve changes, Apply, then Save original + native before reopening. Cancel discards pending input. Reopen replaces unsaved changes with the saved version.';
        status.textContent =
          (input.composing || composing.size ? 'Finish text composition. ' : '') + guidance;
      } else status.textContent = String(error);
    });
  };
root.querySelector<HTMLButtonElement>('#undo')!.onclick = host.undo;
root.querySelector<HTMLButtonElement>('#redo')!.onclick = host.redo;
root.querySelector<HTMLButtonElement>('#revoke')!.onclick = host.revoke;
let loaded: GeoSourceEnvelope | undefined;
try {
  loaded = await storage.load();
} catch (error) {
  errors.push(String(error));
}
installContent(loaded?.request.content ?? emptyGeo(), loaded?.closure ?? [], !!loaded);
if (errors.length) status.textContent = 'Stored source capture refused: ' + errors.join('; ');
else if (loaded) status.textContent = 'Reopened acknowledged native and complete originals';
await refreshVersions().catch((error) => {
  status.textContent = String(error);
});
document.querySelector('h1')!.textContent =
  'reference consumer — original + geographic native saving';
document.querySelector('code')!.textContent = packageHash;
Object.assign(globalThis, { ready: true, geoSourceHost: host });
addEventListener(
  'pagehide',
  () => {
    pageClosed = true;
    clearTimeout(settlementTimer);
    handle.revoke('host-close');
  },
  { once: true },
);
addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});
