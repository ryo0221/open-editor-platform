/** Private v1 ordinary workflow. One real scoped controller/SaveCoordinator; Host owns file lifetimes. */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { contentHash } from '@editor-platform/artifact-core';
import {
  EditorSession,
  EditorInputs,
  command,
  type EditorCommand,
} from '@editor-platform/editor-core';
import {
  ReferenceRegistry,
  type Storage,
  type WriteEvidence,
} from '@editor-platform/extension-runtime/draft2';
import { ManualClock } from '@editor-platform/extension-runtime/reference';
import {
  SchemaEditExperimentRegistry,
  createSchemaEditController,
} from '@editor-platform/extension-runtime/schema-edit-experiment';
import {
  SCHEMA_EDIT_EXPERIMENT_VERSION,
  type SchemaEditDefinition,
} from '@editor-platform/extension-contract/schema-edit-experiment';
import {
  add,
  time,
  videoCommandV1,
  type VideoContentV1,
  type Time,
} from '@editor-platform/video-core';
import { validateHostV1 } from './capacity-v1';
import { inspectOriginalV1 } from './inspect-v1';
import { prepareImportSetV1, type ImportSetV1 } from './import-v1';
export interface LiveV1 {
  originals: Map<string, Blob>;
  plans: Map<string, ImportSetV1>;
}
export interface PersistenceV1 {
  storage: Storage<VideoContentV1>;
  content: VideoContentV1;
  portable(signal: AbortSignal): Promise<{ bytes: Blob; release(): void }>;
  close(): Promise<void>;
  /** Trusted adapter evidence; reconciled only into this Host's existing coordinator. */
  reconcile?(operationId: string, signal: AbortSignal): Promise<WriteEvidence>;
}
export type PersistenceFactoryV1 = (live: LiveV1, file?: Blob) => Promise<PersistenceV1>;
interface SnapshotV1 {
  native: { content: VideoContentV1; revision: unknown };
  originals: { sourceId: string; bytes: Blob; plan: ImportSetV1 }[];
  hash: string;
}
export interface CodecV1 {
  preview(
    snapshot: SnapshotV1,
    at: Time,
    canvas: HTMLCanvasElement,
    signal: AbortSignal,
  ): Promise<unknown>;
  play(
    snapshot: SnapshotV1,
    at: Time,
    canvas: HTMLCanvasElement,
    signal: AbortSignal,
    report: (value: unknown) => void,
  ): Promise<unknown>;
  encode(snapshot: SnapshotV1, signal: AbortSignal): Promise<Blob>;
  verify(bytes: Blob, snapshot: SnapshotV1, signal: AbortSignal): Promise<void>;
}
export const emptyV1 = (): VideoContentV1 => ({
  schema: 'video-core-prototype-v1',
  sources: [],
  sequence: {
    id: 'sequence',
    duration: time(0),
    frameRate: time(25),
    clips: [],
    tracks: [
      { id: 'visual', kind: 'visual', enabled: true, locked: false },
      { id: 'audio', kind: 'audio', enabled: true, locked: false },
    ],
  },
});
const parse = (text: string) => {
  const m = /^(-?\d+)(?:\/(\d+))?$/.exec(text.trim());
  if (!m) throw Error('Use rational seconds');
  return time(Number(m[1]), Number(m[2] ?? 1));
};
export async function mountV1Host(
  root: HTMLElement,
  factory: PersistenceFactoryV1 | undefined,
  codec: CodecV1,
  file?: Blob,
) {
  if (file && !factory) throw Error('Portable opener unavailable');
  const live: LiveV1 = { originals: new Map(), plans: new Map() };
  const persistence: Pick<PersistenceV1, 'content' | 'close'> &
    Partial<Pick<PersistenceV1, 'storage' | 'portable' | 'reconcile'>> = factory
    ? await factory(live, file)
    : { content: emptyV1(), close: async () => {} };
  if (persistence.storage && persistence.storage.key.length > 256) {
    await persistence.close();
    throw Error('VideoHostScopeCapacity');
  }
  const owner = new ReferenceRegistry(new ManualClock()),
    schemaIdentity = { kind: 'literal', value: 'video-core-prototype-v1' } as const;
  const registry = new SchemaEditExperimentRegistry(owner, [
    { artifactKind: 'video', schemaIdentity },
  ]);
  const definition: SchemaEditDefinition<VideoContentV1> = {
    manifest: {
      id: 'video-native-v1',
      version: '0.0.0-experiment.1',
      packageHash: 'a'.repeat(64),
      contractVersion: SCHEMA_EDIT_EXPERIMENT_VERSION,
      artifactKind: 'video',
      schemaIdentity,
      surface: false,
      permissions: ['artifact:read', 'artifact:edit', 'artifact:save'],
      addons: {
        lifecycle: { version: 'lifecycle@0-draft', requirement: 'required' },
        edit: { version: 'local-edit@0-draft', requirement: 'optional' },
        inputs: { version: 'inputs@0-draft', requirement: 'optional' },
        save: { version: 'local-persistence@0-draft', requirement: 'optional' },
      },
      licenseNotices: ['Repository license applies; no additional license grant.'],
    },
    validate: validateHostV1,
    schemaOf: (content) => ({ kind: 'literal', value: content.schema }),
  };
  const installed = registry.install(definition, {
    trust: 'trusted',
    verifiedPin: {
      id: definition.manifest.id,
      version: definition.manifest.version,
      packageHash: definition.manifest.packageHash,
    },
  });
  if (!validateHostV1(persistence.content)) {
    await persistence.close();
    throw Error('VideoHostControlledCapacityOrSchema');
  }
  const opened = installed.open({
    artifactId: persistence.storage?.key ?? 'video-v1-unsaved',
    artifactKind: 'video',
    schemaIdentity,
    session: new EditorSession(persistence.content),
    inputs: new EditorInputs(),
    ...(persistence.storage ? { storage: persistence.storage } : {}),
    allowed: (permission) => permission !== 'artifact:save' || !!persistence.storage,
    subscribePermissions: () => () => {},
    recovery: {
      codecs: [],
      perBoundaryBytes: 2048,
      totalBytes: 8192,
      ttlMs: 1000,
      onRevoke: 'discard',
    },
  });
  if (opened.state !== 'opened') {
    await persistence.close();
    throw Error(opened.code);
  }
  const handle = opened.handle,
    rawEditor = createSchemaEditController(handle.context, {
      beforeMutation: () => {
        if (terminal || closed || unresolvedSave || (busy && !internalMutation))
          throw Error('HostBusyOrUnresolved');
      },
      onError: () => {},
    }),
    life = handle.context.addons.lifecycle.api;
  root.innerHTML =
    '<h1>Video — exact timeline</h1><p>Private v1 review Host · original-inclusive project · local AVC/AAC. Existing v0 projects remain in the v0 Host.</p><label>Import original <input id="import" type="file"></label><label>Open portable project <input id="open" type="file"></label><p id="mode"></p><div id="actions"></div><p id="status" role="status">Ready</p><canvas id="preview" width="270" height="480"></canvas><p id="playback"></p><label>Preview frame <input id="preview-frame" value="0" inputmode="numeric"></label><label>Selected clip <select id="selected"></select></label><label>Split / move time (seconds) <input id="at" value="1/1000"></label><label>Trim start (sequence seconds) <input id="trim-start" value="0"></label><label>Trim end (sequence seconds) <input id="trim-end" value="1"></label><label>Sequence duration (seconds) <input id="duration" value="0"></label><ol id="timeline"></ol><details><summary>Native content</summary><pre id="native"></pre></details>';
  const find = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!,
    status = find('#status'),
    canvas = find<HTMLCanvasElement>('#preview');
  let closed = false,
    busy = false,
    abort: AbortController | undefined,
    settlement: Promise<unknown> = Promise.resolve(),
    generation = 0;
  let terminal = false,
    internalMutation = false,
    unresolvedSave = false,
    inputGeneration = 0;
  let unresolvedOperation: string | undefined;
  let openGeneration = 0;
  let pendingOpen: Promise<void> | undefined,
    disposal: Promise<void> | undefined,
    closing: Promise<void> | undefined;
  const editor: typeof rawEditor = {
    ...rawEditor,
    save: () => saveWithHost(false),
    bindInputs(group) {
      inputGeneration++;
      const binding = rawEditor.bindInputs(group);
      return {
        changed() {
          inputGeneration++;
          binding.changed();
        },
        unregister() {
          inputGeneration++;
          binding.unregister();
        },
      };
    },
  };
  const openToken = () =>
    JSON.stringify([handle.context.basic.read().revision, editor.getSnapshot(), inputGeneration]);
  let activeLabel = '';
  let replacement: { close(): Promise<void> } | undefined;
  function updateBusy() {
    for (const b of root.querySelectorAll<HTMLButtonElement>('#actions button'))
      b.disabled =
        b.textContent === 'Reconcile save'
          ? terminal || busy || !unresolvedSave || !persistence.reconcile
          : b.textContent === 'Stop media'
            ? !busy || !['Preview', 'Playback', 'Export'].includes(activeLabel)
            : terminal ||
              busy ||
              unresolvedSave ||
              (b.textContent === 'Save portable project' && !persistence.storage);
    find<HTMLInputElement>('#import').disabled = terminal || busy || unresolvedSave;
    find<HTMLInputElement>('#open').disabled = terminal || busy || unresolvedSave || !factory;
    for (const input of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      'input:not([type=file]), select',
    ))
      input.disabled = terminal || busy || unresolvedSave;
  }
  const current = () => {
    if (closed || terminal) throw Error('Host closed');
    life.assertCurrent();
  };
  function render() {
    if (closed) return;
    const c = handle.context.basic.read().content,
      select = find<HTMLSelectElement>('#selected'),
      selected = select.value;
    select.replaceChildren();
    find('#timeline').replaceChildren();
    for (const clip of c.sequence.clips) {
      const option = document.createElement('option');
      option.value = clip.id;
      option.textContent = clip.id;
      select.append(option);
      const row = document.createElement('li');
      row.textContent = `${clip.kind} ${clip.id}: ${clip.start.value}/${clip.start.timescale} → ${add(clip.start, clip.duration).value}/${add(clip.start, clip.duration).timescale}`;
      find('#timeline').append(row);
    }
    if ([...select.options].some((o) => o.value === selected)) select.value = selected;
    find<HTMLInputElement>('#duration').value =
      `${c.sequence.duration.value}/${c.sequence.duration.timescale}`;
    find('#native').textContent = JSON.stringify(c);
    root.dataset.revision = JSON.stringify(handle.context.basic.read().revision);
  }
  const stop = () => {
    abort?.abort();
  };
  let renderedRevision = JSON.stringify(handle.context.basic.read().revision);
  const unsubscribe = editor.subscribe(() => {
    if (closed) return;
    const revision = JSON.stringify(handle.context.basic.read().revision);
    if (revision !== renderedRevision && ['Preview', 'Playback', 'Export'].includes(activeLabel))
      stop();
    renderedRevision = revision;
    render();
  });
  render();
  function execute(edit: EditorCommand<VideoContentV1>) {
    current();
    const result = editor.execute({
      baseRevision: handle.context.basic.read().revision,
      command: edit,
    });
    if (result.state !== 'applied') throw Error(JSON.stringify(result));
  }
  const selected = () => find<HTMLSelectElement>('#selected').value;
  const at = () => parse(find<HTMLInputElement>('#at').value);
  async function snapshot(): Promise<SnapshotV1> {
    const native = structuredClone(handle.context.basic.read()),
      originals = native.content.sources.map((s) => {
        const bytes = live.originals.get(s.asset.sha256),
          plan = live.plans.get(s.id);
        if (!bytes || !plan) throw Error('Original closure unavailable');
        return { sourceId: s.id, bytes, plan };
      });
    return { native, originals, hash: await contentHash(native.content) };
  }
  const download = (blob: Blob, name: string) => {
    current();
    const url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };
  async function work(label: string, action: (signal: AbortSignal) => Promise<void>) {
    if (busy || terminal || (unresolvedSave && label !== 'Reconcile'))
      throw Error('Host busy or unresolved Save');
    busy = true;
    activeLabel = label;
    updateBusy();
    stop();
    const previous = settlement;
    abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, life.signal]);
    status.textContent = label;
    settlement = (async () => {
      await previous.catch(() => {});
      try {
        current();
        await action(signal);
        current();
        status.textContent = label + ' complete';
      } catch (e) {
        status.textContent = String(e);
        throw e;
      } finally {
        busy = false;
        activeLabel = '';
        updateBusy();
      }
    })();
    await settlement;
  }
  function button(label: string, action: () => void | Promise<void>) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => {
      try {
        Promise.resolve(action()).catch((e) => {
          status.textContent = String(e);
        });
      } catch (e) {
        status.textContent = String(e);
      }
    };
    find('#actions').append(b);
  }
  button('Split linked clips', () => {
    const c = handle.context.basic.read().content.sequence.clips,
      clip = c.find((c) => c.id === selected());
    if (!clip) throw Error('Select clip');
    const members = c.filter(
      (c) => c.id === clip.id || (clip.linkGroupId && c.linkGroupId === clip.linkGroupId),
    );
    execute(
      videoCommandV1({
        type: 'split',
        clipId: clip.id,
        at: at(),
        rightIds: Object.fromEntries(members.map((c) => [c.id, c.id + ':r' + ++generation])),
        ...(members.length > 1 ? { rightLinkGroupId: 'split:' + generation } : {}),
      }),
    );
  });
  button('Trim selected clip', () =>
    execute(
      videoCommandV1({
        type: 'trim',
        clipId: selected(),
        start: parse(find<HTMLInputElement>('#trim-start').value),
        end: parse(find<HTMLInputElement>('#trim-end').value),
        independent: true,
      }),
    ),
  );
  button('Move linked clips', () =>
    execute(videoCommandV1({ type: 'move', clipId: selected(), delta: at() })),
  );
  button('Resize sequence', () =>
    execute(
      videoCommandV1({
        type: 'resize',
        duration: parse(find<HTMLInputElement>('#duration').value),
      }),
    ),
  );
  button('Undo', () => {
    const r = editor.undo();
    status.textContent = JSON.stringify(r);
  });
  button('Redo', () => {
    const r = editor.redo();
    status.textContent = JSON.stringify(r);
  });
  button('Preview frame', () =>
    work('Preview', async (signal) => {
      const s = await snapshot();
      await codec.preview(
        s,
        time(Number(find<HTMLInputElement>('#preview-frame').value), 25),
        canvas,
        signal,
      );
    }),
  );
  button('Play', () =>
    work('Playback', async (signal) => {
      const s = await snapshot();
      await codec.play(
        s,
        time(Number(find<HTMLInputElement>('#preview-frame').value), 25),
        canvas,
        signal,
        (v) => {
          find('#playback').textContent = JSON.stringify(v);
        },
      );
    }),
  );
  button('Stop media', () => {
    if (['Preview', 'Playback', 'Export'].includes(activeLabel)) stop();
  });
  async function saveWithHost(portableDownload: boolean): ReturnType<typeof rawEditor.save> {
    let result: Awaited<ReturnType<typeof rawEditor.save>> = {
      state: 'refused',
      code: 'HostBusyOrUnresolved',
      message: 'Host busy or unresolved Save',
    };
    try {
      await work('Save', async (signal) => {
        let pending: ReturnType<typeof rawEditor.save>;
        internalMutation = true;
        try {
          pending = rawEditor.save();
        } finally {
          internalMutation = false;
        }
        result = await pending;
        if (result.state === 'outcome' && result.outcome.state === 'indeterminate') {
          unresolvedSave = true;
          unresolvedOperation = result.outcome.operationId;
        }
        signal.throwIfAborted();
        if (result.state !== 'outcome' || result.outcome.state !== 'committed')
          throw Error(JSON.stringify(result));
        if (!portableDownload) return;
        if (!persistence.portable) throw Error('Portable storage unavailable');
        const portable = await persistence.portable(signal);
        try {
          download(portable.bytes, 'video-v1.zip');
        } finally {
          portable.release();
        }
      });
    } catch (e) {
      status.textContent = String(e);
    }
    return result;
  }
  button('Save portable project', async () => {
    await saveWithHost(true);
  });
  async function reconcileSave() {
    if (!unresolvedOperation || !persistence.reconcile) throw Error('Reconciliation unavailable');
    const operationId = unresolvedOperation;
    await work('Reconcile', async (signal) => {
      const evidence = await persistence.reconcile!(operationId, signal);
      owner.saves.reconcile(operationId, evidence);
      const outcome = owner.saves
        .observations()
        .find((o) => o.operationId === operationId)?.outcome;
      if (!outcome || outcome.state === 'indeterminate')
        throw Error('Save remains indeterminate; originals retained');
      unresolvedSave = false;
      unresolvedOperation = undefined;
    });
  }
  button('Reconcile save', reconcileSave);
  button('Export MP4', () =>
    work('Export', async (signal) => {
      const s = await snapshot(),
        bytes = await codec.encode(s, signal);
      await codec.verify(bytes, s, signal);
      signal.throwIfAborted();
      download(bytes, 'video-v1.mp4');
    }),
  );
  find<HTMLInputElement>('#import').onchange = () => {
    const original = find<HTMLInputElement>('#import').files?.[0];
    if (!original) return;
    void work('Import', async (signal) => {
      if (original.size > 256 * 1024 * 1024) throw Error('Original quota');
      const before = handle.context.basic.read(),
        { plan } = await inspectOriginalV1(original, signal),
        h = sha256.create();
      try {
        for (let at = 0; at < original.size; at += 65536) {
          signal.throwIfAborted();
          h.update(new Uint8Array(await original.slice(at, at + 65536).arrayBuffer()));
        }
        const hash = bytesToHex(h.digest()),
          id = 'source:' + crypto.randomUUID(),
          asset = { assetId: 'sha256:' + hash, sha256: hash, byteLength: original.size },
          native = prepareImportSetV1(before.content, plan, asset, id);
        const had = live.originals.has(hash);
        if (
          !had &&
          [...live.originals.values()].reduce((n, b) => n + b.size, original.size) >
            512 * 1024 * 1024
        )
          throw Error('Live original/Undo quota');
        signal.throwIfAborted();
        let committed = false;
        try {
          live.originals.set(hash, original);
          live.plans.set(id, structuredClone(plan));
          internalMutation = true;
          let result;
          try {
            result = editor.execute({
              baseRevision: before.revision,
              command: command('video.v1.import', 'Import exact original', () => native),
            });
          } finally {
            internalMutation = false;
          }
          if (result.state !== 'applied') throw Error(JSON.stringify(result));
          committed = true;
        } finally {
          if (!committed) {
            live.plans.delete(id);
            if (!had) live.originals.delete(hash);
          }
        }
      } finally {
        h.destroy();
      }
    }).catch(() => {});
  };
  find<HTMLInputElement>('#open').onchange = () => {
    const file = find<HTMLInputElement>('#open').files?.[0];
    if (!file) return;
    if (busy || terminal || unresolvedSave) {
      status.textContent = 'Host busy or unresolved Save';
      return;
    }
    const token = openToken(),
      ticket = ++openGeneration;
    busy = true;
    activeLabel = 'Open';
    updateBusy();
    const candidate = document.createElement('section');
    pendingOpen = (async () => {
      const next = await mountV1Host(candidate, factory, codec, file);
      let activated = false;
      try {
        if (terminal || ticket !== openGeneration || unresolvedSave || token !== openToken())
          throw Error('Stale or cancelled Open');
        await dispose();
        if (terminal || ticket !== openGeneration) return;
        replacement = next;
        root.replaceChildren(candidate);
        activated = true;
      } finally {
        if (!activated) await next.close();
      }
    })()
      .catch((e) => {
        status.textContent = String(e);
      })
      .finally(() => {
        busy = false;
        activeLabel = '';
        if (!closed && !terminal) updateBusy();
      });
  };
  updateBusy();
  find('#mode').textContent = persistence.storage
    ? 'Portable storage connected'
    : 'Unsaved session — portable storage unavailable';
  function dispose() {
    if (unresolvedSave) return Promise.reject(Error('Unresolved Save retains Host ownership'));
    if (disposal) return disposal;
    closed = true;
    unsubscribe();
    handle.revoke('host-close');
    disposal = (async () => {
      await persistence.close();
      live.originals.clear();
      live.plans.clear();
    })();
    return disposal;
  }
  function close(): Promise<void> {
    if (closing) return closing;
    if (replacement) {
      const currentReplacement = replacement;
      closing = (async () => {
        await currentReplacement.close();
      })().catch((error) => {
        closing = undefined;
        throw error;
      });
      return closing;
    }
    if (unresolvedSave)
      return Promise.reject(
        Error('Unresolved Save retains Host ownership; reconcile before close'),
      );
    terminal = true;
    openGeneration++;
    stop();
    updateBusy();
    closing = (async () => {
      await settlement.catch(() => {});
      if (unresolvedSave) throw Error('Unresolved Save retains Host ownership');
      await dispose();
      await pendingOpen;
      // Terminal generation prevents pending Open from activating a replacement here.
    })().catch((error) => {
      if (unresolvedSave && !closed) {
        terminal = false;
        closing = undefined;
        updateBusy();
      }
      throw error;
    });
    return closing;
  }
  life.registerDisposable('video-v1-jobs', async () => {
    stop();
    await settlement.catch(() => {});
  });
  return { editor, live, close, reconcileSave, read: () => handle.context.basic.read(), snapshot };
}
