/** Real private Host/factory/SaveCoordinator with synthetic media and explicit test policy. */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { contentHash } from '@editor-platform/artifact-core';
import { time, videoCommandV1, type VideoContentV1 } from '@editor-platform/video-core';
import type { SaveCapture } from '@editor-platform/extension-contract/draft2';
import type { WriteRequest } from '@editor-platform/extension-runtime/draft2';
import {
  mountV1Host,
  type CodecV1,
  type PersistenceFactoryV1,
  type PersistenceV1,
} from '../../host-media/file-source/host-v1';
import type { ImportSetV1 } from '../../host-media/file-source/import-v1';
import { createPersistenceFactoryV1 } from './persistence-v1';
import { TotalCapacity, type TotalCapacityPolicy } from './capacity';
import { ProfileJournalVideoStorage } from './storage';
import { BrowserJournal } from '../browser/journal';
import { blobReader, createProfileBrowserVerifier } from '../browser-verifier/adapter';
import { createScanner, type DigestFactory } from '../portable/io';
import { createProfileProject } from '../portable/project';
import { v1Profile } from '../portable/v1';
import { emptyV1Fixture, v1Fixture } from '../portable/v1-fixture';
import { createZip } from '../portable/zip64';
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
const signal = () => new AbortController().signal;
const scan = createScanner(digest);
const root = document.querySelector<HTMLElement>('#host')!;
const codec: CodecV1 = {
  preview: async () => {
    throw Error('Synthetic fixture: no codec acceptance');
  },
  play: async () => {
    throw Error('Synthetic fixture: no codec acceptance');
  },
  encode: async () => {
    throw Error('Synthetic fixture: no codec acceptance');
  },
  verify: async () => {
    throw Error('Synthetic fixture: no codec acceptance');
  },
};
let capacity: TotalCapacity, factory: PersistenceFactoryV1;
let host: Awaited<ReturnType<typeof mountV1Host>>, persistence: PersistenceV1;
let storage: ProfileJournalVideoStorage<VideoContentV1, ImportSetV1>;
let limits: { journalBytes: number; scratchBytes: number; externalBytes: number };
let marks: SaveCapture[] = [],
  requests: WriteRequest<VideoContentV1>[] = [];
let savedHash: string | null = null;
let pending: ReturnType<typeof host.editor.save> | undefined;
let loseAck = false,
  cancelledRead = false,
  holdReserve = false,
  held = false,
  resume = () => {};
let inputDirty = false,
  invalidInput = false;
let inputBinding: ReturnType<typeof host.editor.bindInputs> | undefined;
async function synthetic() {
  const p = await v1Fixture(scan, false, 131089);
  const entries = await createProfileProject(scan, v1Profile).prepareProject(p, signal());
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  await createZip(scan).writeZip(
    entries,
    {
      write: async (b) => {
        chunks.push(Uint8Array.from(b));
      },
    },
    signal(),
  );
  return new Blob(chunks);
}
async function status() {
  const snapshot = host.read();
  const hash = await contentHash(snapshot.content);
  const usage = await capacity.inspect();
  document.querySelector('#usage')!.textContent = JSON.stringify(usage, null, 2);
  return {
    snapshot,
    hash,
    savedHash,
    draftDirty: savedHash !== hash,
    inputDirty,
    marks: structuredClone(marks),
    requests: structuredClone(requests),
    ownership: storage.resourceOwnership,
    refusal: storage.capacityRefusal,
    journal: await storage.journal.snapshot(),
    scratch: held ? null : await storage.inspectScratch(),
    usage,
    limits,
    originals: host.live.originals.size,
    plans: host.live.plans.size,
    history: structuredClone(storage.history.versions),
    namespace: storage.journal.namespace,
  };
}
const qa = {
  async setup(policy: TotalCapacityPolicy, injectedLimits: typeof limits) {
    limits = structuredClone(injectedLimits);
    capacity = await TotalCapacity.open(policy);
    const reserve = capacity.reserve.bind(capacity);
    capacity.reserve = async (...args) => {
      if (holdReserve) {
        holdReserve = false;
        held = true;
        await new Promise<void>((resolve) => {
          resume = resolve;
        });
        held = false;
      }
      return reserve(...args);
    };
    const actual = createPersistenceFactoryV1({
      digest,
      capacity,
      namespace: () => 'cap-host-' + crypto.randomUUID(),
      newArtifactId: () => crypto.randomUUID(),
      empty: emptyV1Fixture,
      now: () => '2026-10-13T00:00:00Z',
      ...limits,
      authorize: () => true,
    });
    factory = async (live, file) => {
      const p = await actual(live, file);
      if (!(p.storage instanceof ProfileJournalVideoStorage))
        throw Error('Actual factory required');
      const target = p.storage as typeof storage;
      marks = [];
      requests = [];
      savedHash = file ? await contentHash(p.content) : null;
      target.markSaved = (capture) => {
        marks.push(structuredClone(capture));
        savedHash = capture.contentHash;
      };
      const write = target.write.bind(target);
      target.write = (request, abort) => {
        requests.push(structuredClone(request));
        return write(request, abort);
      };
      // Fault below Storage: preserve the capacity reservation, unlike dropping a completed Storage receipt.
      const save = target.journal.save.bind(target.journal);
      target.journal.save = async (...args) => {
        const result = await save(...args);
        if (loseAck && result.state === 'saved') {
          loseAck = false;
          return { state: 'unknown', pin: result.pin };
        }
        return result;
      };
      const reconcile = target.reconcile.bind(target);
      target.reconcile = (id, abort) => reconcile(id, cancelledRead ? AbortSignal.abort() : abort);
      storage = target;
      persistence = p;
      return p;
    };
    return capacity.inspect();
  },
  async seedOld() {
    const directory = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle('closed-host-fixture', { create: true });
    const stream = await (
      await directory.getFileHandle('preserved.bin', { create: true })
    ).createWritable();
    await stream.write(new Uint8Array(4096).fill(37));
    await stream.close();
  },
  async mount() {
    host = await mountV1Host(root, factory, codec, await synthetic());
    return status();
  },
  edit() {
    const result = host.editor.execute({
      baseRevision: host.read().revision,
      command: videoCommandV1({ type: 'resize', duration: time(80) }),
    });
    if (result.state !== 'applied') throw Error(JSON.stringify(result));
  },
  buffer(invalid: boolean) {
    if (!inputBinding)
      inputBinding = host.editor.bindInputs({
        label: 'Synthetic exact sequence duration',
        read: () => ({ dirty: inputDirty, composing: false }),
        focus: () => {},
        prepare: (s) => {
          if (invalidInput) throw Error('Uncommitted invalid duration');
          return {
            baseRevision: s.revision,
            command: videoCommandV1({ type: 'resize', duration: time(80) }),
          };
        },
        committed: () => {
          inputDirty = false;
        },
      });
    invalidInput = invalid;
    inputDirty = true;
    inputBinding.changed();
  },
  start(unknown = false, pauseReserve = false) {
    loseAck = unknown;
    holdReserve = pauseReserve;
    pending = host.editor.save();
  },
  held: () => held,
  resume: () => resume(),
  result: () => pending,
  save: () => host.editor.save(),
  status,
  usage: () => capacity.inspect(),
  cancelRead(value: boolean) {
    cancelledRead = value;
  },
  async reconcile() {
    try {
      await host.reconcileSave();
      return 'settled';
    } catch (e) {
      return String(e);
    }
  },
  async close() {
    try {
      await host.close();
      return 'closed';
    } catch (e) {
      return String(e);
    }
  },
  async files() {
    const values: { path: string; bytes: number; hash: string }[] = [];
    async function walk(dir: FileSystemDirectoryHandle, prefix: string) {
      for await (const [name, item] of (
        dir as FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> }
      ).entries()) {
        if (item.kind === 'directory')
          await walk(item as FileSystemDirectoryHandle, prefix + name + '/');
        else {
          const file = await (item as FileSystemFileHandle).getFile();
          values.push({
            path: prefix + name,
            bytes: file.size,
            hash: (await scan(blobReader(file), signal())).sha256,
          });
        }
      }
    }
    await walk(await navigator.storage.getDirectory(), '');
    return values.sort((a, b) => a.path.localeCompare(b.path));
  },
  async inspectArchive() {
    const lease = await persistence.portable(signal());
    try {
      const opened = await createProfileBrowserVerifier(digest, v1Profile).open(
        blobReader(lease.bytes),
        signal(),
      );
      return {
        capture: opened.project.capture,
        versions: opened.project.versions,
        hash: (await scan(blobReader(lease.bytes), signal())).sha256,
      };
    } finally {
      lease.release();
    }
  },
  /** A fresh authorized recovery owner verifies old storage; it never fabricates the dead coordinator job. */
  async recover(namespace: string, operationId: string) {
    const journal = await BrowserJournal.open(
      namespace,
      limits.journalBytes,
      createProfileBrowserVerifier(digest, v1Profile).verify,
      () => true,
    );
    const recovery = new ProfileJournalVideoStorage(
      'v1-synthetic',
      journal,
      digest,
      namespace + '-scratch',
      limits.scratchBytes,
      {
        journalHead: 0,
        versions: [],
        selectedVersionId: null,
        originals: new Map(),
        plans: new Map(),
      },
      () => '2026-10-13T00:00:00Z',
      { getOriginal: () => undefined, getPlan: () => undefined },
      v1Profile,
      {},
      capacity,
    );
    try {
      const before = await capacity.inspect();
      const aborted = await recovery.reconcile(operationId, AbortSignal.abort());
      const afterAborted = await capacity.inspect();
      const evidence = await recovery.reconcile(operationId, signal());
      if (evidence.state !== 'committed') throw Error('Verified recovery required');
      const restored = await recovery.restore(operationId, signal());
      try {
        host = await mountV1Host(root, factory, codec, restored.file);
        return {
          before,
          aborted,
          afterAborted,
          evidence,
          oldCapture: restored.project.capture,
          current: await status(),
        };
      } finally {
        restored.release();
      }
    } finally {
      journal.close();
    }
  },
};
Object.assign(window, { coordinatorQA: qa });
