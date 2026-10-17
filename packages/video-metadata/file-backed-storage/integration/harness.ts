/** Independent controlled Host using the real public registry/scoped SaveCoordinator APIs. */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { EditorSession, EditorInputs, command } from '@editor-platform/editor-core';
import { ReferenceRegistry } from '@editor-platform/extension-runtime/draft2';
import { ManualClock } from '@editor-platform/extension-runtime/reference';
import {
  SchemaEditExperimentRegistry,
  createSchemaEditController,
} from '@editor-platform/extension-runtime/schema-edit-experiment';
import { videoTimelineExtension } from '@editor-platform/video-metadata/edit';
import type { SaveCapture } from '@editor-platform/extension-contract/draft2';
import type { VideoContent } from '@editor-platform/video-core';
import { contentHash } from '@editor-platform/artifact-core';
import { BrowserJournal } from '../browser/journal';
import { blobReader, createBrowserVerifier } from '../browser-verifier/adapter';
import { createScanner, type DigestFactory } from '../portable/io';
import { createZip } from '../portable/zip64';
import { JournalVideoStorage, type History } from './storage';
import { importOriginal, type OriginalStore } from '../../host-media/import';
const digest: DigestFactory = () => {
  const h = sha256.create();
  return {
    update: (b) => {
      h.update(b);
    },
    hex: () => bytesToHex(h.digest()),
    dispose: () => h.destroy(),
  };
};
const verifier = createBrowserVerifier(digest);
let liveOwned: Pick<History, 'originals' | 'plans'>;
let journal: BrowserJournal, storage: JournalVideoStorage, host: ReturnType<typeof bind>;
let scratchHold = '',
  scratchRecord: unknown;
let phase = '',
  holdBefore = false,
  loseAck = false,
  journalAllowed = true,
  releaseGate = () => {},
  pending: Promise<unknown> | undefined;
const marked: SaveCapture[] = [];
function bind(content: VideoContent, target = storage) {
  const owner = new ReferenceRegistry(new ManualClock()),
    schemaIdentity = { kind: 'literal', value: 'video-core-prototype-v0' } as const;
  const registry = new SchemaEditExperimentRegistry(owner, [
    { artifactKind: 'video', schemaIdentity },
  ]);
  const definition = videoTimelineExtension('a'.repeat(64), {
    createController: createSchemaEditController,
    onError: () => {},
  });
  const session = new EditorSession(content),
    inputs = new EditorInputs();
  const opened = registry
    .install(definition, {
      trust: 'trusted',
      verifiedPin: {
        id: definition.manifest.id,
        version: definition.manifest.version,
        packageHash: definition.manifest.packageHash,
      },
    })
    .open({
      artifactId: 'synthetic',
      artifactKind: 'video',
      schemaIdentity,
      session,
      inputs,
      storage: target,
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
  if (opened.state !== 'opened') throw Error(opened.code);
  const handle = opened.handle,
    editor = createSchemaEditController(handle.context, { onError: () => {} });
  const save = () => {
    const slot = handle.context.addons.save;
    if (slot.state !== 'granted') throw Error('Save unavailable');
    return slot.api.save();
  };
  return { owner, session, handle, editor, save };
}
async function openJournal() {
  journal = await BrowserJournal.open(
    'real-save-integration',
    512 * 1024 ** 2,
    verifier.verify,
    () => journalAllowed,
    async (p) => {
      phase = p;
      if (p === 'committed' && loseAck) throw Error('Injected lost journal acknowledgement');
    },
  );
}
function setStorage(history: History) {
  const live = { originals: new Map(history.originals), plans: new Map(history.plans) };
  liveOwned = live;
  storage = new JournalVideoStorage(
    'synthetic',
    journal,
    digest,
    'real-save-integration-scratch',
    48 * 1024 ** 2,
    history,
    () => '2026-10-13T00:00:00Z',
    { getOriginal: (hash) => live.originals.get(hash), getPlan: (id) => live.plans.get(id) },
    {
      observe: async (at, record) => {
        if (scratchHold === 'scratch-fail-cleaning' && at === 'scratch-cleaning') {
          scratchHold = '';
          throw Error('Injected scratch cleanup interruption');
        }
        if (at === scratchHold) {
          phase = at;
          scratchRecord = record;
          await new Promise<void>((resolve) => {
            releaseGate = resolve;
          });
        }
      },
    },
  );
  storage.markSaved = (capture) => marked.push(structuredClone(capture));
  // Admission pins callback identities: install the stable hook before opening the scope.
  storage.beforeDispatch = async () => {
    if (holdBefore) {
      phase = 'captured';
      await new Promise<void>((r) => {
        releaseGate = r;
      });
    }
  };
}
const qa = {
  async seed() {
    await openJournal();
    const file = document.querySelector('input')!.files![0],
      r = blobReader(file),
      { project } = await verifier.open(r, new AbortController().signal);
    const entries = await createZip(createScanner(digest)).readZip(r, new AbortController().signal);
    const originals = new Map<string, Blob>();
    for (const e of entries)
      if (e.name.startsWith('originals/'))
        originals.set(
          e.name.slice(10, -4),
          file.slice(Number(e.dataOffset), Number(e.dataOffset + e.size)),
        );
    const state = await journal.snapshot();
    if (state.head !== 0) throw Error('Portable import requires empty target');
    setStorage({
      journalHead: 0,
      versions: project.versions,
      selectedVersionId: project.selectedVersionId,
      originals,
      plans: new Map(project.plans.map((p) => [p.sourceId, p.plan])),
    });
    host = bind(project.versions.find((v) => v.versionId === project.selectedVersionId)!.content);
    return qa.status();
  },
  async restore() {
    await openJournal();
    setStorage({
      journalHead: 0,
      versions: [],
      selectedVersionId: null,
      originals: new Map(),
      plans: new Map(),
    });
    const state = await journal.snapshot();
    if (!state.current) throw Error('No completed version');
    const restored = await storage.restore(state.current, new AbortController().signal);
    // File/Blob objects remain retained in History; journal never overwrites completed candidates.
    setStorage(restored.history);
    host = bind(
      restored.project.versions.find((v) => v.versionId === restored.project.selectedVersionId)!
        .content,
    );
    const lifecycle = host.handle.context.addons.lifecycle;
    if (lifecycle.state === 'granted')
      lifecycle.api.registerDisposable('restored-project-lease', restored.release);
    return {
      status: await qa.status(),
      oldCapture: restored.project.capture,
      receiptOperation: restored.project.operationId,
    };
  },
  async status() {
    document.querySelector('pre')!.textContent = JSON.stringify(
      {
        revision: host.session.revision,
        retainedCaptures: storage.retainedCaptures,
        marked,
        observations: host.owner.saves.observations(),
        versions: storage.history.versions.length,
      },
      null,
      2,
    );
    return {
      snapshot: host.handle.context.basic.read(),
      hash: await contentHash(host.session.content),
      retained: storage.retainedCaptures,
      marked: structuredClone(marked),
      observations: host.owner.saves.observations(),
      journal: await journal.snapshot(),
      versions: storage.history.versions.length,
      ownership: storage.resourceOwnership,
      historyHead: storage.history.journalHead,
    };
  },
  async start(mode: string) {
    phase = '';
    scratchHold = mode.startsWith('scratch-') ? mode : '';
    holdBefore = mode.startsWith('hold');
    loseAck = mode.endsWith('unknown');
    journalAllowed = mode !== 'no-write';
    pending = host.save().catch((e) => ({ error: String(e) }));
    return true;
  },
  async fixtureCorruptCandidate(id: string) {
    const op = (await journal.snapshot()).operations.find((o) => o.pin.operationId === id)!;
    const dir = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle('real-save-integration');
    const writer = await (await dir.getFileHandle(op.file)).createWritable();
    await writer.write('injected invalid archive');
    await writer.close();
  },
  async fixtureForeignScratch() {
    const root = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle('real-save-integration-scratch');
    const writer = await (
      await root.getFileHandle('foreign-owned', { create: true })
    ).createWritable();
    await writer.write('must retain');
    await writer.close();
  },
  async fixtureLedgerDamage(remove: boolean) {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('video-scratch-ledger-real-save-integration-scratch');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('ledger', 'readwrite');
        const store = tx.objectStore('ledger');
        if (remove) store.delete('root');
        else store.put({ format: 'wrong' }, 'root');
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  },
  async fixtureLegacyJournal() {
    const snapshot = await journal.snapshot();
    journal.close();
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.deleteDatabase('video-files-real-save-integration');
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('video-files-real-save-integration', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('journal');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('journal', 'readwrite');
        tx.objectStore('journal').put(snapshot, 'root');
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
    return snapshot;
  },
  phase: () => phase,
  pausedRecord: () => scratchRecord,
  ledger: () => storage.inspectScratch(),
  recoverScratch: (id: string, allowed: boolean) =>
    storage.recoverScratch(id, new AbortController().signal, () => allowed),
  async replayScratch(id: string) {
    const record = (await storage.inspectScratch()).find((r) => r.operationId === id)!;
    const pin = record.pin ?? {
      operationId: id,
      capture: record.capture,
      sha256: 'a'.repeat(64),
      bytes: 1,
    };
    const other = await BrowserJournal.open(
      'real-save-integration',
      512 * 1024 ** 2,
      verifier.verify,
      () => true,
    );
    let reads = 0;
    try {
      const result = await other.save(
        pin,
        (await other.snapshot()).head,
        (async function* () {
          reads++;
          yield new Uint8Array([1]);
        })(),
        new AbortController().signal,
      );
      const mismatch = await other.fenceCapture(id, {
        ...record.capture,
        contentHash: '0'.repeat(64),
      });
      return { result, reads, mismatch };
    } finally {
      other.close();
    }
  },
  release() {
    holdBefore = false;
    releaseGate();
  },
  result: () => pending,
  async busy() {
    try {
      return await host.save();
    } catch (e) {
      return { error: String(e) };
    }
  },
  forgetLiveOriginals() {
    liveOwned.originals.clear();
  },
  edit() {
    const result = host.editor.execute({
      baseRevision: host.session.revision,
      command: command<VideoContent>('edit', 'edit', (v) => ({
        ...v,
        sequence: { ...v.sequence, id: 'edited-' + crypto.randomUUID() },
      })),
    });
    if (result.state !== 'applied') throw Error('Edit refused');
  },
  async delayedForget(id: string) {
    const original = journal.reconcile.bind(journal);
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    journal.reconcile = async (operationId, signal) => {
      const result = await original(operationId, signal);
      reached();
      await gate;
      return result;
    };
    try {
      const before = await journal.snapshot();
      const pending = storage.reconcile(id, new AbortController().signal);
      await entered;
      storage.forgetSettled(id);
      release();
      const evidence = await pending;
      let reinserted = false;
      try {
        storage.forgetSettled(id);
        reinserted = true;
      } catch {
        /* Expected absent receipt. */
      }
      return {
        evidence,
        reinserted,
        before,
        after: await journal.snapshot(),
        ownership: storage.resourceOwnership,
      };
    } finally {
      release();
      journal.reconcile = original;
    }
  },
  async wrongEvidence(id: string) {
    const evidence = await storage.reconcile(id, new AbortController().signal);
    if (evidence.state !== 'committed') throw Error('No committed evidence');
    host.owner.saves.reconcile(id, {
      ...evidence,
      capture: { ...evidence.capture, contentHash: '0'.repeat(64) },
    });
    return qa.status();
  },
  async reconcile(id: string) {
    const evidence = await storage.reconcile(id, new AbortController().signal);
    host.owner.saves.reconcile(id, evidence);
    return { evidence, status: await qa.status() };
  },
  async inspect(id: string) {
    const restored = await storage.restore(id, new AbortController().signal);
    try {
      const hashes = [];
      for (const [id, blob] of restored.history.originals)
        hashes.push({
          id,
          size: blob.size,
          actual: (await createScanner(digest)(blobReader(blob), new AbortController().signal))
            .sha256,
        });
      return {
        operationId: restored.project.operationId,
        capture: restored.project.capture,
        versions: restored.project.versions.length,
        hashes,
      };
    } finally {
      restored.release();
    }
  },
  async otherOwner() {
    const previous = storage.history;
    const otherStorage = new JournalVideoStorage(
      'synthetic',
      journal,
      digest,
      'real-save-integration-scratch',
      48 * 1024 ** 2,
      {
        ...previous,
        versions: structuredClone(previous.versions),
        originals: new Map(previous.originals),
        plans: new Map(previous.plans),
      },
      () => '2026-10-13T00:00:00Z',
      {
        getOriginal: (hash) => previous.originals.get(hash),
        getPlan: (id) => previous.plans.get(id),
      },
    );
    const other = bind(host.session.content, otherStorage);
    other.editor.execute({
      baseRevision: other.session.revision,
      command: command<VideoContent>('B', 'B', (v) => ({
        ...v,
        sequence: { ...v.sequence, id: 'other-owner-B' },
      })),
    });
    return other.save();
  },
  async importAfterCapture(undo: boolean) {
    // Fallback allows the same regression to run against exact pre-fix #181.
    const live = storage.live ? liveOwned : storage.history;
    const store: OriginalStore = {
      get: (id) => live.originals.get(id),
      put: (id, b) => {
        live.originals.set(id, b);
      },
      delete: (id) => {
        live.originals.delete(id);
      },
      getPlan: (id) => live.plans.get(id),
      putPlan: (id, p) => {
        live.plans.set(id, p);
      },
      deletePlan: (id) => {
        live.plans.delete(id);
      },
    };
    const plan = structuredClone([...storage.history.plans.values()][0]);
    const added = await importOriginal(
      new Blob(['post-capture-original-B']),
      { inspect: async () => plan },
      store,
      {
        read: () => host.handle.context.basic.read(),
        view: () => host.editor.getSnapshot(),
        execute: (p) => host.editor.execute(p),
        check: () => {
          host.handle.context.basic.read();
        },
      },
      new AbortController().signal,
    );
    if (undo && host.editor.undo().state !== 'applied') throw Error('Import Undo refused');
    return added;
  },
  catalogHas(hash: string, sourceId: string) {
    const live = storage.live ? liveOwned : storage.history;
    return {
      original: live.originals.has(hash),
      plan: live.plans.has(sourceId),
      saved: storage.history.originals.has(hash),
    };
  },
  redo() {
    if (host.editor.redo().state !== 'applied') throw Error('Redo refused');
  },
  releaseLive(hash: string, sourceId: string) {
    const live = storage.live ? liveOwned : storage.history;
    live.originals.delete(hash);
    live.plans.delete(sourceId);
  },
  async oldJob(id: string) {
    try {
      host.owner.saves.reconcile(id, { state: 'unknown' });
      return 'accepted';
    } catch (e) {
      return String(e);
    }
  },
  async scratch() {
    const root = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle('real-save-integration-scratch');
    const names = [];
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys())
      names.push(name);
    return names;
  },
};
Object.assign(window, { qa });
