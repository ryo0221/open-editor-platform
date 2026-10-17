/** Synthetic independent browser owner; no normal Host registration or real media. */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { contentHash } from '@editor-platform/artifact-core';
import { BrowserJournal } from '../browser/journal';
import { createProfileBrowserVerifier } from '../browser-verifier/adapter';
import { v1Profile } from '../portable/v1';
import { emptyV1Fixture } from '../portable/v1-fixture';
import type { DigestFactory } from '../portable/io';
import { ProfileJournalVideoStorage } from './storage';
import { TotalCapacity, type TotalCapacityPolicy } from './capacity';
import type { ScratchPhase } from './scratch';
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
let capacity: TotalCapacity;
const owners = new Map<string, Awaited<ReturnType<typeof owner>>>();
async function owner(
  name: string,
  journalBytes: number,
  fail: string,
  scratchNamespace = name + '-scratch',
) {
  const content = emptyV1Fixture();
  const journal = await BrowserJournal.open(
    name,
    journalBytes,
    createProfileBrowserVerifier(digest, v1Profile).verify,
    () => true,
    async (phase) => {
      if (phase === fail) throw Error('Injected acknowledgement/phase failure');
    },
  );
  let stages: ScratchPhase[] = [];
  let held = false,
    resume = () => {};
  const storage = new ProfileJournalVideoStorage(
    'synthetic',
    journal,
    digest,
    scratchNamespace,
    1024 ** 2,
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
    {
      observe: async (phase) => {
        stages.push(phase);
        if ('hold:' + phase === fail) {
          held = true;
          await new Promise<void>((resolve) => {
            resume = resolve;
          });
          held = false;
        }
        if (phase === fail) throw Error('Injected scratch cleanup failure');
      },
    },
    capacity,
  );
  return {
    journal,
    storage,
    clearFault() {
      fail = '';
      resume();
    },
    held: () => held,
    async save(id: string) {
      stages = [];
      const capture = {
        scope: { artifactId: 'synthetic', sessionId: name, generation: 'one' },
        revision: { kind: 'local-draft' as const, sessionId: name, sequence: 0 },
        contentHash: await contentHash(content),
      };
      const release = storage.retainCapture({ ...capture, content });
      try {
        const evidence = await storage.write(
          { operationId: id, capture, content },
          new AbortController().signal,
        );
        return {
          evidence,
          stages,
          refusal: storage.capacityRefusal,
          state: await journal.snapshot(),
          usage: await capacity.inspect(),
        };
      } finally {
        release();
      }
    },
  };
}
let reservedHeld = false,
  releaseReserved = () => {};
const qa = {
  async directOwner(alias: string, journal: string, scratch: string) {
    owners.set(alias, await owner(journal, 100000, '', scratch));
  },
  holdAfterReserve() {
    const reserve = capacity.reserve.bind(capacity);
    let first = true;
    capacity.reserve = async (...args) => {
      const result = await reserve(...args);
      if (first) {
        first = false;
        reservedHeld = true;
        await new Promise<void>((resolve) => {
          releaseReserved = resolve;
        });
        reservedHeld = false;
      }
      return result;
    };
  },
  reservedHeld: () => reservedHeld,
  resumeReserved: () => releaseReserved(),
  async open(policy: TotalCapacityPolicy) {
    capacity = await TotalCapacity.open(policy);
    return capacity.inspect();
  },
  async seed(path: string, bytes: number) {
    const root = await navigator.storage.getDirectory();
    const [namespace, file] = path.split('/');
    const dir = await root.getDirectoryHandle(namespace, { create: true });
    const stream = await (await dir.getFileHandle(file, { create: true })).createWritable();
    await stream.write(new Uint8Array(bytes));
    await stream.close();
  },
  async owner(name: string, quota = 1024 ** 2, fail = '') {
    owners.set(name, await owner(name, quota, fail));
  },
  async save(name: string, id: string) {
    return owners.get(name)!.save(id);
  },
  async reconcile(name: string, id: string) {
    return owners.get(name)!.storage.reconcile(id, new AbortController().signal);
  },
  async recover(name: string, id: string) {
    return owners.get(name)!.storage.recoverScratch(id, new AbortController().signal, () => true);
  },
  held(name: string) {
    return owners.get(name)!.held();
  },
  clearFault(name: string) {
    owners.get(name)!.clearFault();
  },
  inspect: () => capacity.inspect(),
  reserve: (id: string, path: string, bytes: number) => capacity.reserve(id, path, bytes),
};
Object.assign(window, { capacityQA: qa });
