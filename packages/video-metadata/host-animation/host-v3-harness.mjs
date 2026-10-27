import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  createAnimation2,
  createAnimationLayer2,
  prepareAnimation2,
} from '@editor-platform/animation-core/v2';
import { productCodecV3 } from './product-codec-v3.mjs';
import { time } from '@editor-platform/video-core';
import { mountV3Host, emptyV3 } from './host-v3';
import { createAdmittedPersistenceV3 } from './storage-admission-v3.mjs';
import { createPortableProjects } from '../file-backed-storage/portable/versioned';
import { createScanner } from '../file-backed-storage/portable/io';
import { blobReader } from '../file-backed-storage/browser-verifier/adapter';
const digest = () => {
  const h = sha256.create();
  return {
    update: (b) => h.update(b),
    hex: () => bytesToHex(h.digest()),
    dispose: () => h.destroy(),
  };
};
let readAllowed = true,
  editAllowed = true,
  activeLeases = 0;
const listeners = new Set();
const originals = [0, 123].map((x, i) => {
  const content = createAnimation2();
  content.compositions[0].layers = [createAnimationLayer2('rect', 'box', 960000)];
  content.compositions[0].layers[0].transform.x = x;
  return {
    label: 'Native box',
    source: {
      artifactId: 'native-animation',
      versionId: 'v' + (i + 1),
      contentHash: prepareAnimation2(content).contentHash,
      compositionId: 'root',
    },
    content,
  };
});
const sources = {
  async list() {
    if (!readAllowed) throw Error('Source denied');
    return originals.map(({ label, source }) => ({ label, source }));
  },
  async retain(source, signal) {
    const record = originals.find((r) => JSON.stringify(r.source) === JSON.stringify(source));
    if (!record || !readAllowed) throw Error('Exact source missing or denied');
    activeLeases++;
    let released = false;
    return {
      snapshot: record.content,
      assertAuthorized() {
        signal.throwIfAborted();
        if (!readAllowed || released) throw Error('Source denied');
      },
      release() {
        if (!released) {
          released = true;
          activeLeases--;
        }
      },
    };
  },
};
let adapter, host, portable;
const factory = createAdmittedPersistenceV3({
  digest,
  namespace: () => 'animation-v3-' + globalThis.crypto.randomUUID(),
  newArtifactId: () => globalThis.crypto.randomUUID(),
  empty: () => ({ ...emptyV3(), sequence: { ...emptyV3().sequence, duration: time(4) } }),
  now: () => '2026-10-25T00:00:00Z',
  journalBytes: 16 * 1024 ** 2,
  scratchBytes: (globalThis.videoTextPermissionFixture ? 32 : 4) * 1024 ** 2,
  externalBytes: (globalThis.videoTextPermissionFixture ? 32 : 4) * 1024 ** 2,
  authorize: () => readAllowed,
});
async function mount(file) {
  const root = globalThis.document.querySelector('main');
  root.replaceChildren();
  host = await mountV3Host(
    root,
    async (live, input) => (adapter = await factory(live, input)),
    productCodecV3,
    sources,
    file,
    {
      allowed: (p) => (p === 'artifact:edit' ? editAllowed : true),
      subscribePermissions: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
  );
  return true;
}
globalThis.animationReady = mount();
globalThis.animationFixture = {
  read: () => host.read().content,
  leases: () => activeLeases,
  setRead(value) {
    readAllowed = value;
    for (const fn of listeners) fn();
  },
  setEdit(value) {
    editAllowed = value;
    for (const fn of listeners) fn();
  },
  async save() {
    const result = await host.editor.save();
    if (result.state !== 'outcome' || result.outcome.state !== 'committed')
      throw Error(JSON.stringify(result));
    return result;
  },
  async capture() {
    const lease = await adapter.portable(new globalThis.AbortController().signal);
    try {
      portable = lease.bytes;
    } finally {
      lease.release();
    }
    return portable.size;
  },
  archiveBytes: async () => Array.from(new Uint8Array(await portable.arrayBuffer())),
  async reopenWithEdit(value) {
    await host.close();
    editAllowed = value;
    await mount(portable);
    return host.read().content;
  },
  async reopen() {
    await host.close();
    await mount(portable);
    return host.read().content;
  },
  async archiveVersions() {
    const project = await createPortableProjects(createScanner(digest)).v3.openProject(
      blobReader(portable),
      new globalThis.AbortController().signal,
    );
    return project.versions.map((v) => v.content.sequence.clips[0]?.embed?.source.versionId);
  },
  async oldReaderRefuses() {
    try {
      await createPortableProjects(createScanner(digest)).v2.openProject(
        blobReader(portable),
        new globalThis.AbortController().signal,
      );
      return false;
    } catch {
      return true;
    }
  },
  clearSources() {
    originals.length = 0;
  },
  close: () => host.close(),
};
