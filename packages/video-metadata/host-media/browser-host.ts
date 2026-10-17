/** Local-only review Host; no production registry or root app changes. */
import { canonicalJson, contentHash } from '@editor-platform/artifact-core';
import { EditorSession, EditorInputs } from '@editor-platform/editor-core';
import { time, type VideoContent } from '@editor-platform/video-core';
import { videoTimelineExtension } from '@editor-platform/video-metadata/edit';
import { ReferenceRegistry } from '@editor-platform/extension-runtime/draft2';
import { ManualClock } from '@editor-platform/extension-runtime/reference';
import {
  SchemaEditExperimentRegistry,
  createSchemaEditController,
} from '@editor-platform/extension-runtime/schema-edit-experiment';
import type { SchemaEditHandle } from '@editor-platform/extension-contract/schema-edit-experiment';
import type { ControlledSurfaceController } from '@editor-platform/extension-contract/controlled-surface';
import { importOriginal, type ImportBinding } from './import';
import { MediaStore, openBundle, VideoBundleStorage, type OpenedBundle } from './bundle';
import { StagedBlobTarget } from './staging';
import { mp4Probe } from './mp4-probe';
import { referencePreview } from './reference-preview';
import { VideoExport, type Mp4Codec } from './export';
let admittedCodec: Mp4Codec | undefined;
let exportJob: VideoExport | undefined;
let exportBindingSequence = 0;
/** Called by the compiled product entrypoint after codec review; no user-code loading. */
export function installProductCodec(codec: Mp4Codec) {
  admittedCodec = codec;
  connectExport();
}
const status = document.querySelector<HTMLElement>('#status')!,
  stage = document.querySelector<HTMLElement>('#timeline')!,
  canvas = document.querySelector<HTMLCanvasElement>('#preview')!,
  importInput = document.querySelector<HTMLInputElement>('#import')!,
  openInput = document.querySelector<HTMLInputElement>('#open')!,
  saveButton = document.querySelector<HTMLButtonElement>('#save')!;
const owner = new ReferenceRegistry(new ManualClock()),
  schemaIdentity = { kind: 'literal', value: 'video-core-prototype-v0' } as const;
const registry = new SchemaEditExperimentRegistry(owner, [
  { artifactKind: 'video', schemaIdentity },
]);
let editor: ControlledSurfaceController<VideoContent>,
  handle: SchemaEditHandle<VideoContent>,
  store: MediaStore,
  target: StagedBlobTarget;
const definition = videoTimelineExtension('a'.repeat(64), {
  createController: createSchemaEditController,
  onError: (e) => {
    throw e;
  },
  mounted: (value) => {
    editor = value;
  },
});
const installed = registry.install(definition, {
  trust: 'trusted',
  verifiedPin: {
    id: definition.manifest.id,
    version: definition.manifest.version,
    packageHash: definition.manifest.packageHash,
  },
});
const empty = (): VideoContent => ({
  schema: 'video-core-prototype-v0',
  sources: [],
  sequence: {
    id: 'sequence',
    duration: time(0),
    frameRate: time(25),
    clips: [],
    tracks: [
      { id: 'visual', kind: 'visual', locked: false, enabled: true },
      { id: 'audio', kind: 'audio', locked: false, enabled: true },
    ],
  },
});
function activate(opened?: OpenedBundle) {
  const nextStore = opened?.store ?? new MediaStore(),
    nextTarget = new StagedBlobTarget(),
    nextStorage = new VideoBundleStorage('project', nextStore, nextTarget);
  nextStorage.versions = opened?.versions ?? [];
  nextStorage.selectedVersionId = opened?.selected.versionId ?? null;
  const result = installed.open({
    artifactId: 'project',
    artifactKind: 'video',
    schemaIdentity,
    session: new EditorSession(opened?.selected.content ?? empty()),
    inputs: new EditorInputs(),
    storage: nextStorage,
    allowed: () => true,
    subscribePermissions: () => () => {},
    recovery: {
      codecs: [],
      perBoundaryBytes: 2048,
      totalBytes: 8192,
      ttlMs: 1000,
      onRevoke: 'discard',
    },
  });
  if (result.state !== 'opened') throw Error(result.code);
  const previousEditor = editor,
    candidate = document.createElement('div');
  try {
    result.handle.mount(candidate);
  } catch (e) {
    editor = previousEditor;
    result.handle.revoke('host-close');
    throw e;
  }
  handle?.revoke('host-close');
  handle = result.handle;
  store = nextStore;
  target = nextTarget;
  connectExport();
  // Host supplies the bundle download action; hide the generic metadata-only save affordance.
  for (const button of candidate.querySelectorAll('button'))
    if (button.textContent === 'Save native JSON') button.hidden = true;
  stage.replaceChildren(candidate);
  editor.subscribe(renderSummary);
  renderSummary();
}
function renderSummary() {
  const content = handle.context.basic.read().content;
  document.querySelector('#summary')!.textContent = JSON.stringify({
    sources: content.sources.length,
    video: content.sequence.clips.filter((c) => c.kind === 'video').length,
    audio: content.sequence.clips.filter((c) => c.kind === 'audio').length,
    native: content,
  });
}
let previewRequest: AbortController | undefined;
let previewSequence = 0;
let previewSettlement: Promise<void> = Promise.resolve();
async function preview(play = false) {
  const previousSettlement = previewSettlement;
  previewRequest?.abort();
  const request = new AbortController();
  previewRequest = request;
  const capturedHandle = handle,
    native = structuredClone(handle.context.basic.read());
  if (!native.content.sources.length) return;
  if (!admittedCodec?.preview) throw Error('Product preview codec unavailable');
  const life = capturedHandle.context.addons.lifecycle;
  if (life.state !== 'granted') throw Error('Preview lifecycle unavailable');
  const signal = AbortSignal.any([request.signal, life.api.signal]);
  const unsubscribe = editor.subscribe(() => request.abort());
  let finish!: () => void;
  const settlement = new Promise<void>((resolve) => {
    finish = resolve;
  });
  previewSettlement = settlement;
  life.api.registerDisposable(`video-preview-${++previewSequence}`, () => {
    request.abort();
    return settlement;
  });
  try {
    await previousSettlement;
    signal.throwIfAborted();
    const originals = native.content.sources.map((source) => {
      const bytes = store.get(source.asset.sha256),
        plan = store.getPlan(source.id);
      if (!bytes || !plan) throw Error('Preview original unavailable');
      return { sourceId: source.id, bytes, plan };
    });
    const snapshot = { native, originals, hash: await contentHash(native.content) };
    signal.throwIfAborted();
    const frame = Number(document.querySelector<HTMLInputElement>('#preview-frame')!.value);
    if (!Number.isSafeInteger(frame) || frame < 0) throw Error('Invalid preview frame');
    const at = time(frame, 25);
    let evidence: unknown;
    if (play) {
      if (!admittedCodec.play) throw Error('Audio preview unavailable');
      evidence = await admittedCodec.play(snapshot, at, canvas, signal, (value) => {
        const text = document.querySelector<HTMLElement>('#playback-status')!;
        text.dataset.evidence = JSON.stringify(value);
        const row = value as { state: string; clock: string };
        text.textContent = `${row.state} · ${row.clock}`;
      });
    } else {
      try {
        evidence = await admittedCodec.preview(snapshot, at, canvas, signal);
      } catch (error) {
        signal.throwIfAborted();
        evidence = await referencePreview(snapshot, at, canvas, signal, String(error));
      }
    }
    signal.throwIfAborted();
    capturedHandle.context.basic.read();
    canvas.dataset.rendered = 'true';
    canvas.dataset.sourceHash = native.content.sources[0].asset.sha256;
    canvas.dataset.evidence = JSON.stringify(evidence);
    document.querySelector('#preview-accuracy')!.textContent =
      (evidence as { mode?: string }).mode === 'browser-reference'
        ? 'Browser reference preview — frame/sample accuracy is not guaranteed'
        : 'Indexed timeline preview';
  } finally {
    unsubscribe();
    finish();
  }
}

let busy = false;
async function action(work: () => Promise<void>) {
  if (busy) return;
  if (owner.saves.observations().some((j) => !j.outcome || j.outcome.state === 'indeterminate')) {
    status.textContent = 'Save reconciliation required';
    return;
  }
  busy = true;
  importInput.disabled = openInput.disabled = saveButton.disabled = true;
  status.textContent = 'Working';
  try {
    await work();
    renderSummary();
  } catch (e) {
    status.textContent = String(e);
  } finally {
    busy = false;
    importInput.disabled = openInput.disabled = saveButton.disabled = false;
  }
}
importInput.onchange = () => {
  const file = importInput.files?.[0];
  if (!file) return;
  void action(async () => {
    const binding: ImportBinding = {
      read: () => handle.context.basic.read(),
      view: () => editor.getSnapshot(),
      execute: (p) => editor.execute(p),
      check: () => {
        handle.context.basic.read();
      },
    };
    await importOriginal(file, mp4Probe, store, binding, new AbortController().signal);
    try {
      await preview();
      status.textContent = 'Imported media; timeline frame ready';
    } catch (e) {
      status.textContent = 'Imported media; preview unavailable: ' + String(e);
    }
  });
};
function requireCleanInputs() {
  const slot = handle.context.addons.inputs;
  if (slot.state !== 'granted') throw Error('Inputs unavailable');
  const state = slot.api.getSnapshot();
  if (state.dirty || state.composing) throw Error('Pending inputs: apply or cancel before opening');
}
openInput.onchange = () => {
  const file = openInput.files?.[0];
  if (!file) return;
  void action(async () => {
    requireCleanInputs();
    const current = handle,
      revision = handle.context.basic.read().revision;
    const candidate = await openBundle(file, new AbortController().signal);
    // Validate selected originals against the bounded preview profile before Host activation.
    for (const version of candidate.versions)
      for (const source of version.content.sources) {
        const actual = await mp4Probe.inspect(
          candidate.store.get(source.asset.sha256)!,
          new AbortController().signal,
        );
        if (canonicalJson(actual) !== canonicalJson(candidate.store.getPlan(source.id)))
          throw Error('Original interpretation mismatch');
      }
    if (handle !== current || handle.context.basic.read().revision.sequence !== revision.sequence)
      throw Error('Reopen stale');
    requireCleanInputs();
    activate(candidate);
    try {
      await preview();
      status.textContent = 'Reopened from bundle only; timeline frame ready';
    } catch (e) {
      status.textContent = 'Reopened bundle; preview unavailable: ' + String(e);
    }
  });
};
saveButton.onclick = () => {
  void action(async () => {
    const grant = handle.context.addons.save;
    if (grant.state !== 'granted') throw Error('Save unavailable');
    const outcome = await grant.api.save();
    if (outcome.state !== 'committed') throw Error('Save ' + outcome.state);
    const bytes = target.latest;
    if (!bytes) throw Error('No completed bundle');
    const url = URL.createObjectURL(bytes),
      link = document.createElement('a');
    link.href = url;
    link.download = 'video-project.vbp';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = 'Verified bundle download requested';
  });
};
activate();
status.textContent = 'Empty Host';

function connectExport() {
  exportJob?.dispose();
  exportJob = undefined;
  const button = document.querySelector<HTMLButtonElement>('#export')!;
  button.disabled = !admittedCodec;
  if (!admittedCodec) return;
  const capturedHandle = handle,
    capturedEditor = editor;
  exportJob = new VideoExport(
    {
      read: () => capturedHandle.context.basic.read(),
      check: () => {
        if (handle !== capturedHandle) throw Error('Export Host replaced');
        capturedHandle.context.basic.read();
        const view = capturedEditor.getSnapshot();
        if (view.state !== 'open' || !view.canSave || view.saving)
          throw Error('Export authority/save unavailable');
        requireCleanInputs();
        if (
          owner.saves.observations().some((j) => !j.outcome || j.outcome.state === 'indeterminate')
        )
          throw Error('Save reconciliation required');
      },
    },
    store,
    admittedCodec,
  );
  const lifetime = capturedHandle.context.addons.lifecycle;
  if (lifetime.state !== 'granted') {
    exportJob.dispose();
    exportJob = undefined;
    button.disabled = true;
    throw Error('Export lifecycle unavailable');
  }
  const boundJob = exportJob;
  lifetime.api.registerDisposable(`video-export-${++exportBindingSequence}`, () =>
    boundJob.dispose(),
  );
}
document.querySelector<HTMLButtonElement>('#cancel-export')!.onclick = () => exportJob?.cancel();
document.querySelector<HTMLButtonElement>('#export')!.onclick = () => {
  void action(async () => {
    const job = exportJob;
    if (!job) throw Error('Codec adoption review pending');
    const result = await job.run(new AbortController().signal);
    if (job !== exportJob || job.completed !== result) throw Error('Export expired');
    // Download follows verified in-memory publication; no server or remote encode.
    const url = URL.createObjectURL(result.bytes),
      link = document.createElement('a');
    link.href = url;
    link.download = 'video-export.mp4';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.dataset.provenance = JSON.stringify(admittedCodec?.provenance?.(result.bytes));
    status.textContent = 'Verified MP4 download requested';
  });
};

document.querySelector<HTMLButtonElement>('#seek-preview')!.onclick = () => {
  void action(async () => {
    await preview();
    status.textContent = 'Timeline frame ready';
  });
};

document.querySelector<HTMLButtonElement>('#stop-preview')!.onclick = () => previewRequest?.abort();
document.querySelector<HTMLButtonElement>('#play-preview')!.onclick = () => {
  const text = document.querySelector<HTMLElement>('#playback-status')!;
  text.textContent = 'preparing';
  text.dataset.evidence = JSON.stringify({
    state: 'preparing',
    chunks: [],
    frames: [],
    rebuffer: [],
  });
  void preview(true).catch((e) => {
    if (!(e instanceof DOMException && e.name === 'AbortError')) status.textContent = String(e);
  });
};
