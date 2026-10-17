/** Test-only, metadata fixtures: real v1/v2 Host + Storage, no codec acceptance. */
import { TotalCapacity } from '../../file-backed-storage/integration/capacity';
import { createPersistenceFactoryV1 } from '../../file-backed-storage/integration/persistence-v1';
import { createPersistenceFactoryV2 } from '../../file-backed-storage/integration/persistence-v2';
import { emptyV1Fixture } from '../../file-backed-storage/portable/v1-fixture';
import { emptyV2Fixture } from '../../file-backed-storage/portable/v2-fixture';
import { mountV1Host } from '../file-source/host-v1';
import { mountV2Host } from './host-v2';
import { time, videoCommandV1, videoCommandV2 } from '@editor-platform/video-core';
import {
  validationDigest,
  validationPolicy,
  validationLimits,
} from './capacity-validation-policy.mjs';
const version = new globalThis.URL(globalThis.location.href).searchParams.get('v');
const capacity = await TotalCapacity.open(validationPolicy);
let retainedOld;
let persistence,
  host,
  chunks = 0,
  held = false,
  hold = false,
  resume,
  pending,
  admitted;
async function hash(file) {
  const h = validationDigest();
  try {
    for (let at = 0; at < file.size; at += 65536)
      h.update(new Uint8Array(await file.slice(at, at + 65536).arrayBuffer()));
    return h.hex();
  } finally {
    h.dispose();
  }
}
const competing = [];
const reserve = capacity.reserve.bind(capacity);
capacity.reserve = async (...args) => {
  if (!hold) return reserve(...args);
  hold = false;
  const usage = await capacity.inspect();
  // Explicit competing ledger owners, no files; no browser quota override or saved-file deletion.
  let remaining = Math.floor((usage.availableBytes - 2 * args[2]) / 2),
    index = 0;
  if (remaining <= 0) throw Error('Expected ample initial test capacity');
  while (remaining > 0) {
    const bytes = Math.min(512 * 1024 ** 2, remaining),
      id = 'competing:owner-' + index++,
      scratchPath = 'competing-capacity/preparation-' + globalThis.crypto.randomUUID();
    await reserve(id, scratchPath, bytes);
    competing.push({ id, scratchPath });
    remaining -= bytes;
  }
  const result = await reserve(...args);
  admitted = await capacity.inspect();
  held = true;
  await new Promise((r) => {
    resume = r;
  });
  held = false;
  return result;
};
const factory = (version === '1' ? createPersistenceFactoryV1 : createPersistenceFactoryV2)({
  digest: validationDigest,
  capacity,
  // v1 archive limits retain their existing 256MiB defaults; only v2 uses approved512MiB.
  ...validationLimits,
  ...(version === '1' ? { externalBytes: 256 * 1024 ** 2, scratchBytes: 256 * 1024 ** 2 } : {}),
  namespace: () => 'cross-v' + version + '-' + globalThis.crypto.randomUUID(),
  newArtifactId: () => globalThis.crypto.randomUUID(),
  empty: version === '1' ? emptyV1Fixture : emptyV2Fixture,
  now: () => '2026-10-13T00:00:00Z',
  authorize: () => true,
});
const codec = Object.fromEntries(
  ['preview', 'play', 'encode', 'verify'].map((k) => [
    k,
    async () => {
      throw Error('No codec in metadata test');
    },
  ]),
);
host = await (version === '1' ? mountV1Host : mountV2Host)(
  globalThis.document.querySelector('main'),
  async (...args) => {
    persistence = await factory(...args);
    persistence.storage.scratchHooks.observe = async (phase) => {
      if (phase === 'scratch-chunk') chunks++;
    };
    return persistence;
  },
  codec,
);
globalThis.crossQA = {
  edit(n) {
    const result = host.editor.execute({
      baseRevision: host.read().revision,
      command: (version === '1' ? videoCommandV1 : videoCommandV2)({
        type: 'resize',
        duration: time(n),
      }),
    });
    if (result.state !== 'applied') throw Error(JSON.stringify(result));
  },
  save: () => host.editor.save(),
  startHeld() {
    hold = true;
    pending = host.editor.save();
  },
  held: () => held,
  pending: () => pending,
  resume: () => resume(),
  result: () => pending,
  async settleCompeting() {
    for (const { id, scratchPath } of competing) await capacity.settle(id, scratchPath, 'no-write');
    return capacity.inspect();
  },
  async status() {
    return {
      version,
      native: host.read(),
      chunks,
      ownership: persistence.storage.resourceOwnership,
      transition: host.transitionState?.(),
      saveEnabled: ![...globalThis.document.querySelectorAll('#actions button')].find(
        (b) => b.textContent === 'Save portable project',
      ).disabled,
      reconcileEnabled: ![...globalThis.document.querySelectorAll('#actions button')].find(
        (b) => b.textContent === 'Reconcile save',
      ).disabled,
      usage: await capacity.inspect(),
      admitted,
      journal: await persistence.storage.journal.snapshot(),
      history: globalThis.structuredClone(persistence.storage.history.versions),
      refusal: persistence.storage.capacityRefusal,
      scratch: held ? null : await persistence.storage.inspectScratch(),
    };
  },
  async retainOld() {
    retainedOld = await persistence.portable(new globalThis.AbortController().signal);
  },
  oldHash: () => hash(retainedOld.bytes),
  async archiveHash() {
    const lease = await persistence.portable(new globalThis.AbortController().signal);
    try {
      return await hash(lease.bytes);
    } finally {
      lease.release();
    }
  },
  async close() {
    retainedOld?.release();
    await host.close();
    capacity.close();
  },
};
