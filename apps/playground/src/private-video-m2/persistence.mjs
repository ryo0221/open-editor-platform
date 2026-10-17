// Host-private glue over the reviewed ports. No public export or parallel native history.
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { contentHash } from '@editor-platform/artifact-core';
import { emptyV2 } from '../../../../packages/video-metadata/host-media/m2/host-v2';
import { createAdmittedPersistenceV2 } from '../../../../packages/video-metadata/host-media/m2/storage-admission-v2.mjs';
import { validationLimits } from '../../../../packages/video-metadata/host-media/m2/capacity-validation-policy.mjs';
import { openPortableFile } from '../../../../packages/video-metadata/file-backed-storage/browser-verifier/external-file';
import { createProfileBrowserVerifier } from '../../../../packages/video-metadata/file-backed-storage/browser-verifier/adapter';
import { BrowserJournal } from '../../../../packages/video-metadata/file-backed-storage/browser/journal';
import { v2Profile } from '../../../../packages/video-metadata/file-backed-storage/portable/v2';
import { publishM2LocatorLocked } from './catalog';
export const digest = () => {
  const h = sha256.create();
  return {
    update: (bytes) => h.update(bytes),
    hex: () => bytesToHex(h.digest()),
    dispose: () => h.destroy(),
  };
};
const MiB = 1024 ** 2;
export const budget = {
  journalBytes: 1024 * MiB,
  ...validationLimits,
  liveBytes: 512 * MiB,
};
export async function acquireProject(id) {
  let release, ready, refused;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const admitted = new Promise((resolve, reject) => {
    ready = resolve;
    refused = reject;
  });
  const owner = globalThis.navigator.locks
    .request('normal-video-m2-owner:' + id, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        refused(Error('Project is already open in another tab'));
        return;
      }
      ready();
      await held;
    })
    .catch(refused);
  await admitted;
  return async () => {
    release();
    await owner;
  };
}
export async function committedProject(entry, signal) {
  // Refuse missing data before BrowserJournal.open can create an empty namespace.
  const root = await globalThis.navigator.storage.getDirectory();
  await root.getDirectoryHandle(entry.namespace, { create: false });
  const journal = await BrowserJournal.open(
    entry.namespace,
    budget.journalBytes,
    createProfileBrowserVerifier(digest, v2Profile).verify,
    () => true,
  );
  let lease;
  try {
    const state = await journal.snapshot();
    if (!state.current) throw Error('No committed Video project');
    lease = await journal.lease(state.current, signal);
    return {
      file: lease.file(),
      close() {
        lease.release();
        journal.close();
      },
    };
  } catch (error) {
    lease?.release();
    journal.close();
    throw error;
  }
}
export function normalPersistence(entry, notify, capacity) {
  if (!capacity) throw Error('M2 validation requires coordinated capacity');
  const id = entry?.id ?? globalThis.crypto.randomUUID();
  let expectedNamespace = entry?.namespace;
  const namespace = 'normal-video-m2-' + globalThis.crypto.randomUUID();
  let persistence,
    savedHash,
    savedCapture,
    savedLocator,
    indexError,
    initialHistory,
    cachedHistory,
    historyGeneration = 0,
    committed = false,
    indexPending = 0,
    publication = Promise.resolve();
  const factory = createAdmittedPersistenceV2({
    digest,
    capacity,
    namespace: () => namespace,
    newArtifactId: () => globalThis.crypto.randomUUID(),
    empty: emptyV2,
    now: () => new Date().toISOString(),
    ...budget,
    authorize: () => true,
  });
  const publish = (capture, retry = false) => {
    if (!retry)
      savedLocator = {
        id,
        namespace,
        name: entry?.name ?? 'Video M2 project ' + id.slice(0, 8),
        updatedAt: new Date().toISOString(),
      };
    const locator = savedLocator;
    savedHash = capture.contentHash;
    savedCapture = globalThis.structuredClone(capture);
    committed = true;
    cachedHistory = undefined;
    historyGeneration++;
    indexPending++;
    publication = publication.then(async () => {
      try {
        await publishM2LocatorLocked(locator, expectedNamespace);
        expectedNamespace = namespace;
        indexError = undefined;
        notify({ locator });
      } catch (error) {
        indexError = error;
        notify({ error: 'Archive committed; Library registration failed: ' + String(error) });
      } finally {
        indexPending--;
      }
    });
    return publication;
  };
  return {
    id,
    get savedHash() {
      return savedHash;
    },
    get indexPending() {
      return indexPending > 0;
    },
    get indexError() {
      return indexError;
    },
    async factory(live, file) {
      if (persistence) throw Error('One normal workspace per persistence owner');
      if (file) {
        const opened = await openPortableFile(
          file,
          digest,
          new globalThis.AbortController().signal,
          budget.externalBytes,
        );
        try {
          if (opened.kind !== 'v2')
            throw Error('Non-v2 project requires matching Host; no migration');
          initialHistory = {
            selectedVersionId: opened.project.selectedVersionId,
            versions: globalThis.structuredClone(opened.project.versions),
          };
        } finally {
          opened.release();
        }
      }
      const p = await factory(live, file);
      try {
        if ([...live.originals.values()].reduce((n, b) => n + b.size, 0) > budget.liveBytes)
          throw Error('Live catalog quota');
        p.storage.markSaved = publish; // Existing current-capture callback; no fabricated receipt.
        persistence = p;
        if (entry) savedHash = await contentHash(p.content);
        return p;
      } catch (error) {
        await p.close();
        throw error;
      }
    },
    async versions() {
      if (!persistence) throw Error('Project not ready');
      if (!committed) return globalThis.structuredClone(initialHistory ?? { versions: [] });
      if (cachedHistory) return globalThis.structuredClone(cachedHistory);
      const generation = historyGeneration;
      const lease = await persistence.portable(new globalThis.AbortController().signal);
      try {
        const opened = await openPortableFile(
          lease.bytes,
          digest,
          new globalThis.AbortController().signal,
          budget.externalBytes,
        );
        try {
          const validated = {
            selectedVersionId: opened.project.selectedVersionId,
            versions: globalThis.structuredClone(opened.project.versions),
          };
          if (generation === historyGeneration) cachedHistory = validated;
          return globalThis.structuredClone(validated);
        } finally {
          opened.release();
        }
      } finally {
        lease.release();
      }
    },
    async retryLocator() {
      if (!committed) throw Error('Save a version first');
      await publish(savedCapture, true);
      if (indexError) throw indexError;
    },
  };
}
