import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { contentHash } from '@editor-platform/artifact-core';
import { mountV1Host, emptyV1 } from './host-v1';
import { productCodecV1 } from './product-codec-v1.mjs';
import { inspectOriginalV1 } from './inspect-v1';
import { checkRetainedProbesV1 } from './retained-probe-v1';
import { createPersistenceFactoryV1 } from '../../file-backed-storage/integration/persistence-v1';
import { openPortableFile } from '../../file-backed-storage/browser-verifier/external-file';
const digest = () => {
  const h = sha256.create();
  return {
    update: (b) => h.update(b),
    hex: () => bytesToHex(h.digest()),
    dispose: () => h.destroy(),
  };
};
const MiB = 1024 ** 2;
const budget = {
  journalBytes: 1024 * MiB,
  scratchBytes: 256 * MiB,
  externalBytes: 256 * MiB,
  liveBytes: 512 * MiB,
};
const baseFactory = createPersistenceFactoryV1({
  digest,
  namespace: () => 'iphone-v1-' + globalThis.crypto.randomUUID(),
  newArtifactId: () => globalThis.crypto.randomUUID(),
  empty: emptyV1,
  now: () => new Date().toISOString(),
  ...budget,
  // Private trusted local reference Host, not a product authorization policy.
  authorize: () => true,
});
let activePersistence, activeLive;
const admission = [];
const factory = async (live, file) => {
  if (file) {
    // Storage validates structure/hashes/retained closure. Video owns compressed-source semantics.
    const opened = await openPortableFile(
      file,
      digest,
      new globalThis.AbortController().signal,
      budget.externalBytes,
    );
    try {
      if (opened.kind !== 'v1') throw Error('v0 project requires v0 Host');
      const originalProbes = await checkRetainedProbesV1(
        opened.project,
        opened.originals,
        async (original) =>
          (await inspectOriginalV1(original, new globalThis.AbortController().signal)).plan,
      );
      admission.push({
        kind: opened.kind,
        retainedVersions: opened.project.versions.length,
        originalProbes,
      });
    } finally {
      opened.release();
    }
  }
  const p = await baseFactory(live, file);
  if ([...live.originals.values()].reduce((n, b) => n + b.size, 0) > budget.liveBytes) {
    await p.close();
    throw Error('Live catalog quota');
  }
  activePersistence = p;
  activeLive = live;
  return p;
};
async function hashBlob(blob) {
  const h = digest();
  try {
    for (let at = 0; at < blob.size; at += 65536)
      h.update(new Uint8Array(await blob.slice(at, at + 65536).arrayBuffer()));
    return h.hex();
  } finally {
    h.dispose();
  }
}
const root = globalThis.document.querySelector('main');
globalThis.videoV1Ready = (async () => {
  const directory = await globalThis.navigator.storage.getDirectory();
  const initialEntries = [];
  for await (const [name] of directory.entries()) initialEntries.push(name);
  const host = await mountV1Host(root, factory, productCodecV1);
  globalThis.videoPortable = {
    initialEntries,
    budget,
    admission,
    close: host.close,
    async status() {
      const originals = [];
      for (const [hash, blob] of activeLive.originals)
        originals.push({ hash, bytes: blob.size, actualHash: await hashBlob(blob) });
      const native = JSON.parse(root.querySelector('#native').textContent);
      return {
        native,
        hash: await contentHash(native),
        originals,
        plans: [...activeLive.plans],
        reconcileAvailable: typeof activePersistence.reconcile === 'function',
      };
    },
    async inspectSaved() {
      const lease = await activePersistence.portable(new globalThis.AbortController().signal);
      try {
        const opened = await openPortableFile(
          lease.bytes,
          digest,
          new globalThis.AbortController().signal,
          budget.externalBytes,
        );
        try {
          return {
            kind: opened.kind,
            versions: opened.project.versions,
            selectedVersionId: opened.project.selectedVersionId,
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
  };
})();
