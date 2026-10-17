/** Local verification entry only: actual Host/factory with bounded diagnostic hooks. */
import {
  createCapacityValidation,
  validationDigest,
  validationLimits,
  validationPolicy,
} from './capacity-validation.mjs';
import { canonicalJson } from '@editor-platform/artifact-core';
import { openPortableFile } from '../../file-backed-storage/browser-verifier/external-file';
import { scratchStatus } from '../indexed-media/scratch.mjs';
const need = (ok, message) => {
  if (!ok) throw Error(message);
};
let session,
  persistence,
  chunks = 0;
const events = [];
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
const root = globalThis.document.querySelector('main');
const label = globalThis.document.createElement('label');
label.textContent = 'Open approved local validation archive ';
const input = globalThis.document.createElement('input');
input.type = 'file';
input.id = 'validation-open';
label.append(input);
root.before(label);
const notice = globalThis.document.createElement('p');
notice.textContent =
  'Isolated local validation only: coordinated logical storage2GiB; archive512MiB; project copies1GiB. Uncoordinated writers excluded; no physical quota guarantee or saved-file deletion.';
root.before(notice);
globalThis.videoV2Ready = createCapacityValidation(root, {
  onCapacity(capacity) {
    for (const name of ['reserve', 'candidate', 'settle']) {
      const method = capacity[name].bind(capacity);
      capacity[name] = async (...args) => {
        try {
          const value = await method(...args);
          events.push({ name, state: 'complete', usage: await capacity.inspect() });
          return value;
        } catch (error) {
          events.push({
            name,
            state: 'refused',
            error: String(error),
            usage: await capacity.inspect(),
          });
          throw error;
        }
      };
    }
  },
  onPersistence(p) {
    persistence = p;
    p.storage.scratchHooks.observe = async (phase) => {
      if (phase === 'scratch-chunk') chunks++;
    };
  },
}).then((value) => {
  session = value;
  globalThis.closeVideoV2 = () => session.close();
});
input.onchange = async () => {
  const file = input.files?.[0];
  if (!file) return;
  input.disabled = true;
  try {
    await session.replace(file);
  } catch (error) {
    notice.textContent = String(error);
  } finally {
    input.disabled = false;
    input.value = '';
  }
};
async function archive(file) {
  const opened = await openPortableFile(
    file,
    validationDigest,
    new globalThis.AbortController().signal,
    validationLimits.externalBytes,
  );
  try {
    return {
      receipt: opened.receipt,
      versions: globalThis.structuredClone(opened.project.versions),
      originals: [...opened.originals.keys()],
    };
  } finally {
    opened.release();
  }
}
globalThis.capacityQA = {
  async status() {
    return {
      limits: validationLimits,
      policy: validationPolicy,
      usage: await session.capacity.inspect(),
      events: globalThis.structuredClone(events),
      chunks,
      journal: await persistence.storage.journal.snapshot(),
      history: globalThis.structuredClone(persistence.storage.history.versions),
      ownership: persistence.storage.resourceOwnership,
      transition: session.slot.current().host.transitionState(),
      refusal: persistence.storage.capacityRefusal,
      scratch: await persistence.storage.inspectScratch(),
      media: scratchStatus(),
      native: session.slot.current().host.read(),
    };
  },
  async inspect() {
    return archive(globalThis.document.querySelector('#inspect').files[0]);
  },
  async quotaRefusal() {
    const host = session.slot.current().host,
      beforeNative = globalThis.structuredClone(host.read()),
      beforeHistory = globalThis.structuredClone(persistence.storage.history.versions),
      beforeJournal = await persistence.storage.journal.snapshot();
    const lease = await persistence.portable(new globalThis.AbortController().signal);
    let oldHash;
    const archiveBytes = lease.bytes.size;
    try {
      oldHash = await hash(lease.bytes);
    } finally {
      lease.release();
    }
    const usage = await session.capacity.inspect();
    // Competing no-write owners hold ledger capacity. Browser physical quota is not overridden.
    let remaining = Math.max(1, Math.ceil((usage.availableBytes - 2 * archiveBytes + 65536) / 2)),
      index = 0;
    const competing = [];
    while (remaining > 0) {
      const bytes = Math.min(512 * 1024 ** 2, remaining),
        id = 'validation-competing:owner-' + index++;
      const scratchPath = 'validation-competing/preparation-' + globalThis.crypto.randomUUID();
      await session.capacity.reserve(id, scratchPath, bytes);
      competing.push({ id, scratchPath, bytes });
      remaining -= bytes;
    }
    const beforeUsage = await session.capacity.inspect(),
      beforeChunks = chunks;
    const result = await host.editor.save();
    need(
      result.state === 'outcome' &&
        result.outcome.state === 'aborted-before-write' &&
        result.outcome.proof === 'adapter-no-write-guarantee',
      'Expected definitive adapter no-write outcome',
    );
    const refusedOwnership = persistence.storage.resourceOwnership,
      refusedTransition = host.transitionState();
    need(
      refusedOwnership.captures === 0 && refusedOwnership.unresolvedWrites === 0,
      'Refusal retained capture or unresolved write',
    );
    need(
      !refusedTransition.unresolvedSave && !refusedTransition.busy,
      'Refusal left Host unknown/busy latch',
    );
    const refusedScratch = await persistence.storage.inspectScratch();
    need(
      refusedScratch.every((record) => record.phase === 'done'),
      'Refusal left unresolved scratch',
    );
    const afterJournal = await persistence.storage.journal.snapshot(),
      whileCompeting = await session.capacity.inspect();
    need(
      JSON.stringify(whileCompeting.reservations) === JSON.stringify(beforeUsage.reservations),
      'Refused Save changed another owner reservation',
    );
    for (const owner of competing)
      await session.capacity.settle(owner.id, owner.scratchPath, 'no-write');
    const afterUsage = await session.capacity.inspect();
    const afterLease = await persistence.portable(new globalThis.AbortController().signal);
    let afterHash;
    try {
      afterHash = await hash(afterLease.bytes);
    } finally {
      afterLease.release();
    }
    need(
      persistence.storage.capacityRefusal?.stage === 'total',
      'Expected total preflight refusal',
    );
    need(chunks === beforeChunks, 'Refused Save wrote archive scratch chunks');
    need(
      JSON.stringify(host.read()) === JSON.stringify(beforeNative),
      'Refusal changed native/revision',
    );
    need(
      JSON.stringify(persistence.storage.history.versions) === JSON.stringify(beforeHistory),
      'Refusal changed retained history',
    );
    need(
      JSON.stringify(afterJournal.current) === JSON.stringify(beforeJournal.current),
      'Refusal replaced saved archive',
    );
    need(oldHash === afterHash, 'Old saved archive bytes changed');
    need(
      afterUsage.reservations.length === 0 && afterUsage.reservedAdditionalBytes === 0,
      'Reservation leak',
    );
    need(!afterUsage.overBudget, 'Approved managed bound exceeded');
    // Same live Host/coordinator must accept a fresh operation without reconcile/remount/reset.
    const previous = await persistence.portable(new globalThis.AbortController().signal);
    let retry;
    try {
      const retryResult = await host.editor.save();
      need(
        retryResult.state === 'outcome' && retryResult.outcome.state === 'committed',
        'Same-owner Save after capacity release did not commit',
      );
      need(
        retryResult.outcome.operationId !== result.outcome.operationId,
        'Retry reused refused operation',
      );
      need((await hash(previous.bytes)) === oldHash, 'Retry mutated old saved archive');
      const current = await persistence.portable(new globalThis.AbortController().signal);
      try {
        const stored = await archive(current.bytes);
        need(stored.versions.length === beforeHistory.length + 1, 'Retry retained-version count');
        need(
          canonicalJson(stored.versions.slice(0, -1)) === canonicalJson(beforeHistory),
          'Retry changed prior retained versions',
        );
        need(
          canonicalJson(stored.versions.at(-1).content) === canonicalJson(beforeNative.content),
          'Retry captured different native',
        );
        retry = {
          result: retryResult,
          stored,
          hash: await hash(current.bytes),
          bytes: current.bytes.size,
          native: host.read(),
          ownership: persistence.storage.resourceOwnership,
          transition: host.transitionState(),
          usage: await session.capacity.inspect(),
          journal: await persistence.storage.journal.snapshot(),
        };
      } finally {
        current.release();
      }
    } finally {
      previous.release();
    }
    need(
      retry.ownership.captures === 0 &&
        retry.ownership.unresolvedWrites === 0 &&
        !retry.transition.unresolvedSave &&
        !retry.transition.busy,
      'Retry left unresolved ownership',
    );
    need(
      retry.usage.reservations.length === 0 &&
        retry.usage.reservedAdditionalBytes === 0 &&
        !retry.usage.overBudget,
      'Retry did not settle capacity',
    );
    return {
      result,
      refusedOwnership,
      refusedTransition,
      refusedScratch,
      retry,
      competing,
      whileCompeting,
      beforeUsage,
      afterUsage,
      refusal: persistence.storage.capacityRefusal,
      oldHash,
      afterHash,
      archiveBytes,
      noScratchChunks: true,
      nativePreserved: true,
      historyPreserved: true,
    };
  },
};
