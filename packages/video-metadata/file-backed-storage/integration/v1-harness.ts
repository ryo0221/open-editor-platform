/** Private exact #194 Host with storage adapter; synthetic media bytes, no codec acceptance. */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { contentHash } from '@editor-platform/artifact-core';
import {
  mountV1Host,
  type PersistenceV1,
  type CodecV1,
} from '../../host-media/file-source/host-v1';
import type { LiveV1 } from '../../host-media/file-source/host-v1';
import { ProfileJournalVideoStorage } from './storage';
import type { VideoContentV1 } from '@editor-platform/video-core';
import type { ImportSetV1 } from '../../host-media/file-source/import-v1';
import { createPersistenceFactoryV1 } from './persistence-v1';
import { openPortableFile } from '../browser-verifier/external-file';
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
const scan = createScanner(digest);
const root = document.querySelector<HTMLElement>('#host')!;
let host: Awaited<ReturnType<typeof mountV1Host>>, persistence: PersistenceV1;
let cancelReconcile = false,
  dropAck = false,
  held = false,
  releaseAck = () => {};
let pendingSave: ReturnType<typeof host.editor.save> | undefined;
let pendingClose: Promise<string> | undefined;
const owners: { persistence: PersistenceV1; live: LiveV1; closes: number; reconciles: number }[] =
  [];
const codec: CodecV1 = {
  preview: async () => {
    throw Error('Synthetic bytes; codec not under test');
  },
  play: async () => {
    throw Error('Synthetic bytes; codec not under test');
  },
  encode: async () => {
    throw Error('Synthetic bytes; codec not under test');
  },
  verify: async () => {
    throw Error('Synthetic bytes; codec not under test');
  },
};
const factory = createPersistenceFactoryV1({
  digest,
  namespace: () => 'v1-' + crypto.randomUUID(),
  newArtifactId: () => crypto.randomUUID(),
  empty: emptyV1Fixture,
  now: () => '2026-10-13T00:00:00Z',
  journalBytes: 16 * 1024 ** 2,
  scratchBytes: 4 * 1024 ** 2,
  externalBytes: 4 * 1024 ** 2,
  authorize: () => true,
});
const trackedFactory: typeof factory = async (live, file) => {
  const p = await factory(live, file);
  const record = { persistence: p, live, closes: 0, reconciles: 0 };
  owners.push(record);
  // Inject only acknowledgement loss; archive writing, verification and reconciliation stay real.
  const write = p.storage.write.bind(p.storage);
  p.storage.write = async (request, signal) => {
    const evidence = await write(request, signal);
    if (dropAck && evidence.state === 'committed') {
      held = true;
      await new Promise<void>((resolve) => {
        releaseAck = resolve;
      });
      dropAck = false;
      held = false;
      return { state: 'unknown' };
    }
    return evidence;
  };
  const sameStorage = p.storage;
  if (!(sameStorage instanceof ProfileJournalVideoStorage))
    throw Error('Expected actual factory storage');
  const reconcile = sameStorage.reconcile.bind(sameStorage);
  sameStorage.reconcile = (id, signal) => {
    record.reconciles++;
    return reconcile(id, cancelReconcile ? AbortSignal.abort() : signal);
  };
  const close = p.close.bind(p);
  p.close = async () => {
    record.closes++;
    await close();
  };
  persistence = p;
  return p;
};
async function synthetic(selectedEmpty: boolean) {
  const p = await v1Fixture(scan, selectedEmpty, 131089),
    entries = await createProfileProject(scan, v1Profile).prepareProject(
      p,
      new AbortController().signal,
    );
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  await createZip(scan).writeZip(
    entries,
    {
      write: async (b) => {
        chunks.push(Uint8Array.from(b));
      },
    },
    new AbortController().signal,
  );
  return new Blob(chunks);
}
const qa = {
  async seed(parentOnly = false) {
    const file = await synthetic(parentOnly);
    host = await mountV1Host(root, trackedFactory, codec, file);
    return qa.status();
  },
  async reopen() {
    host = await mountV1Host(
      root,
      trackedFactory,
      codec,
      document.querySelector<HTMLInputElement>('#portable-input')!.files![0],
    );
    return qa.status();
  },
  async status() {
    return {
      content: structuredClone(host.read().content),
      hash: await contentHash(host.read().content),
      liveOriginals: host.live.originals.size,
      livePlans: host.live.plans.size,
    };
  },
  async save() {
    const result = await host.editor.save();
    if (result.state !== 'outcome') throw Error(JSON.stringify(result));
    return result.outcome;
  },
  startUnknown() {
    dropAck = true;
    pendingSave = host.editor.save();
  },
  held: () => held,
  startPendingClose() {
    pendingClose = host.close().then(
      () => 'closed',
      (e) => String(e),
    );
  },
  releaseAck() {
    releaseAck();
  },
  unknownResult: () => pendingSave,
  pendingCloseResult: () => pendingClose,
  cancelReconciliationRead(value: boolean) {
    cancelReconcile = value;
  },
  async reconcileHost() {
    try {
      await host.reconcileSave();
      return 'settled';
    } catch (e) {
      return String(e);
    }
  },
  owners() {
    return owners.map((o) => ({
      key: o.persistence.storage.key,
      closes: o.closes,
      reconciles: o.reconciles,
      port: typeof o.persistence.reconcile === 'function',
      originals: o.live.originals.size,
      plans: o.live.plans.size,
      ownership: (o.persistence.storage as ProfileJournalVideoStorage<VideoContentV1, ImportSetV1>)
        .resourceOwnership,
    }));
  },
  async download() {
    const lease = await persistence.portable(new AbortController().signal);
    const a = document.createElement('a');
    const url = URL.createObjectURL(lease.bytes);
    a.href = url;
    a.download = 'portable-v1.zip';
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      lease.release();
    }, 1000);
  },
  async inspectCurrent() {
    const lease = await persistence.portable(new AbortController().signal);
    try {
      const opened = await openPortableFile(
        lease.bytes,
        digest,
        new AbortController().signal,
        4 * 1024 ** 2,
      );
      try {
        return {
          kind: opened.kind,
          versions: opened.project.versions,
          plans: opened.project.plans,
          originals: [...opened.originals].map(([hash, v]) => ({ hash, bytes: v.size })),
          receipt: opened.receipt,
        };
      } finally {
        opened.release();
      }
    } finally {
      lease.release();
    }
  },
  async leases() {
    const file = await synthetic(true),
      maxBytes = 4 * 1024 ** 2;
    let maximumRead = 0;
    const source = new Blob([file]);
    source.arrayBuffer = async () => {
      throw Error('Whole external archive read prohibited');
    };
    const slice = source.slice.bind(source);
    source.slice = (start, end, type) => {
      const b = slice(start, end, type),
        read = b.arrayBuffer.bind(b);
      b.arrayBuffer = async () => {
        maximumRead = Math.max(maximumRead, b.size);
        return read();
      };
      return b;
    };
    const opened = await openPortableFile(source, digest, new AbortController().signal, maxBytes);
    const original = [...opened.originals.values()][0],
      bytes = await original.read(0, 4, new AbortController().signal);
    let oversized = false;
    try {
      await original.read(0, 65537, new AbortController().signal);
    } catch {
      oversized = true;
    }
    const late = original.read(0, 4, new AbortController().signal);
    opened.release();
    let lateRejected = false;
    try {
      await late;
    } catch {
      lateRejected = true;
    }
    let blobRejected = false;
    try {
      original.blob();
    } catch {
      blobRejected = true;
    }
    let capped = false;
    try {
      await openPortableFile(file, digest, new AbortController().signal, file.size - 1);
    } catch {
      capped = true;
    }
    return {
      maximumRead,
      bytes: [...bytes],
      oversized,
      lateRejected,
      blobRejected,
      capped,
      remaining: opened.originals.size,
    };
  },
  async v0() {
    const file = document.querySelector<HTMLInputElement>('#portable-input')!.files![0];
    const opened = await openPortableFile(
      file,
      digest,
      new AbortController().signal,
      4 * 1024 ** 2,
    );
    const kind = opened.kind,
      versions = structuredClone(opened.project.versions);
    opened.release();
    const live = { originals: new Map(), plans: new Map() };
    let rejected = false;
    try {
      const p = await factory(live, file);
      await p.close();
    } catch {
      rejected = true;
    }
    return {
      kind,
      versions,
      rejected,
      liveOriginals: live.originals.size,
      livePlans: live.plans.size,
    };
  },
  async close() {
    await host.close();
    let refused = false;
    try {
      await persistence.portable(new AbortController().signal);
    } catch {
      refused = true;
    }
    return { refused, liveOriginals: host.live.originals.size };
  },
};
Object.assign(window, { qa });
