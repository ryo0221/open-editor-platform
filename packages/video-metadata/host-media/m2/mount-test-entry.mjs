import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { emptyV2 } from './host-v2';
import { productCodecV2 } from './product-codec-v2.mjs';
import { createAdmittedPersistenceV2 } from './storage-admission-v2.mjs';
import { createV2MountSlot } from './mount-adapter.mjs';
const need = (ok, message) => {
  if (!ok) throw Error(message);
};
const defer = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const wait = async (test) => {
  for (let i = 0; i < 1000; i++) {
    if (test()) return;
    await new Promise((r) => globalThis.setTimeout(r, 10));
  }
  throw Error('Test condition not reached');
};
const reject = async (job, text) => {
  try {
    await job;
  } catch (e) {
    need(String(e).includes(text), String(e));
    return;
  }
  throw Error('Expected rejection: ' + text);
};
const digest = () => {
  const h = sha256.create();
  return {
    update: (b) => h.update(b),
    hex: () => bytesToHex(h.digest()),
    dispose: () => h.destroy(),
  };
};
globalThis.runMountCheck = async () => {
  const root = globalThis.document.querySelector('main'),
    slot = createV2MountSlot(root),
    owners = [],
    proofs = [];
  let namespaces = 0;
  function options(id, { delay, file, failPublication = false } = {}) {
    const owner = { id, closes: 0, marks: [], failPublication };
    owners.push(owner);
    const factory = createAdmittedPersistenceV2({
      digest,
      namespace: () => {
        namespaces++;
        return 'mount-' + globalThis.crypto.randomUUID();
      },
      newArtifactId: () => globalThis.crypto.randomUUID(),
      empty: emptyV2,
      now: () => new Date().toISOString(),
      journalBytes: 1024 ** 3,
      scratchBytes: 256 * 1024 ** 2,
      externalBytes: 256 * 1024 ** 2,
      authorize: () => true,
    });
    return {
      file,
      codec: productCodecV2,
      factory: async (live, input) => {
        if (delay) await delay.promise;
        const p = await factory(live, input);
        owner.persistence = p;
        p.storage.beforeDispatch = async () => owner.dispatchHook?.();
        p.storage.markSaved = (c) => {
          owner.marks.push(c);
          owner.savedHash = c.contentHash;
        };
        const close = p.close.bind(p);
        p.close = async () => {
          await close();
          owner.closes++;
        };
        return p;
      },
      assertCanLeave: async ({ snapshot, initialHash, fromPortable }) => {
        if (owner.failPublication) throw Error('Publication pending');
        if (
          snapshot.hash !== (owner.savedHash ?? initialHash) ||
          (fromPortable && !owner.savedHash)
        )
          throw Error('Save before leaving');
      },
    };
  }
  const a = await slot.replace(options('a')),
    ownerA = owners[0];
  const input = a.target.querySelector('#import'),
    data = new globalThis.DataTransfer();
  data.items.add(globalThis.document.querySelector('#fixture').files[0]);
  input.files = data.files;
  input.dispatchEvent(new globalThis.Event('change'));
  await wait(() => a.target.querySelector('#status').textContent === 'Import complete');
  const click = (name) =>
    [...a.target.querySelectorAll('button')].find((b) => b.textContent === name).click();
  const set = (id, value) => {
    const n = a.target.querySelector(id);
    n.value = value;
    n.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
  };
  a.target.querySelector('#selected').value = a.host
    .read()
    .content.sequence.clips.find((c) => c.kind === 'audio').id;
  set('#gain', '25');
  click('Set volume');
  const original = globalThis.structuredClone(a.host.read());
  await reject(slot.replace(options('unsaved')), 'Save before leaving');
  need(slot.current() === a && ownerA.closes === 0 && !a.target.inert, 'Unsaved owner lost');
  await a.host.editor.save();
  need(ownerA.marks.length === 1, 'Initial save not marked');
  const portable = await ownerA.persistence.portable(new globalThis.AbortController().signal),
    archive = portable.bytes;
  portable.release();
  // Inner replacement must remain disabled even through controller notifications and synthetic events.
  const nested = a.target.querySelector('#open'),
    count = namespaces;
  need(
    nested.disabled &&
      nested.closest('label').hidden &&
      globalThis.getComputedStyle(nested.closest('label')).display === 'none',
    'Nested Open enabled or visible',
  );
  const transfer = new globalThis.DataTransfer();
  transfer.items.add(new globalThis.File([archive], 'inner.zip'));
  nested.files = transfer.files;
  nested.dispatchEvent(new globalThis.Event('change'));
  await new Promise((r) => globalThis.setTimeout(r, 0));
  need(
    namespaces === count && JSON.stringify(a.host.read()) === JSON.stringify(original),
    'Nested Open replaced owner',
  );
  globalThis.console.log('mount stage', proofs.length);
  proofs.push('inner-open-disabled');
  await reject(slot.replace(options('bad', { file: new globalThis.Blob(['not an archive']) })), '');
  need(slot.current() === a && ownerA.closes === 0, 'Admission failure lost live owner');
  const delay = defer(),
    pending = slot.replace(options('stale', { delay }));
  const pendingResult = reject(pending, 'Stale workspace candidate');
  set('#duration', '3');
  delay.resolve();
  await pendingResult;
  need(
    slot.current() === a && a.target.querySelector('#duration').value === '3',
    'Delayed restore stole input',
  );
  await reject(slot.replace(options('dirty')), 'Apply or reset duration');
  click('Reset duration');
  globalThis.console.log('mount stage', proofs.length);
  proofs.push('failed-and-stale-candidates-retain-owner');
  ownerA.failPublication = true;
  await reject(slot.replace(options('publication')), 'Publication pending');
  ownerA.failPublication = false;
  need(slot.current() === a && !a.target.inert, 'Publication failure stranded owner');
  set('#duration', '3');
  click('Resize sequence');
  // Hold the actual coordinator after capture, before journal dispatch.
  const captured = defer(),
    resume = defer();
  ownerA.dispatchHook = () => {
    captured.resolve();
    return resume.promise;
  };
  const saving = a.host.editor.save();
  await Promise.race([
    captured.promise,
    saving.then(() => {
      throw Error('Save did not enter dispatch gate');
    }),
  ]);
  await reject(slot.replace(options('saving')), 'Workspace operation pending');
  need(slot.current() === a && ownerA.closes === 0, 'Pending save lost owner');
  resume.resolve();
  await saving;
  ownerA.dispatchHook = undefined;
  need(ownerA.marks.length === 2, 'Save ordering changed');
  // Real durable save with deliberately lost acknowledgement; same owner must reconcile.
  const journal = ownerA.persistence.storage.journal,
    save = journal.save.bind(journal);
  journal.save = async (...args) => {
    const result = await save(...args);
    return result.state === 'saved' ? { state: 'unknown', pin: result.pin } : result;
  };
  set('#duration', '4');
  click('Resize sequence');
  const lost = await a.host.editor.save();
  need(lost.state === 'outcome' && lost.outcome.state === 'indeterminate', 'Lost ACK not unknown');
  await reject(slot.replace(options('unknown')), 'Unresolved Save');
  await reject(slot.close(), 'Unresolved Save');
  need(slot.current() === a && ownerA.closes === 0 && !a.target.inert, 'Unknown owner lost');
  journal.save = save;
  await a.host.reconcileSave(lost.outcome.operationId);
  need(ownerA.marks.length === 3, 'Reconciled saved ordering changed');
  need(nested.disabled, 'Notification enabled inner Open');
  globalThis.console.log('mount stage', proofs.length);
  proofs.push('pending-publication-unknown-save-guards');
  // Newer candidate wins, older asynchronous preparation closes exactly once.
  const old = defer(),
    slow = slot.replace(options('slow', { delay: old })),
    slowResult = reject(slow, 'Stale workspace candidate');
  const newer = await slot.replace(options('newer', { file: archive }));
  old.resolve();
  await slowResult;
  need(slot.current() === newer && ownerA.closes === 1, 'Latest candidate did not own workspace');
  need(newer.host.read().content.schema === 'video-core-prototype-v2', 'Wrong schema');
  need(newer.host.live.originals.size === 1, 'Original ownership missing');
  await newer.host.editor.save();
  await globalThis.captureMount();
  const play = [...newer.target.querySelectorAll('button')].find((b) => b.textContent === 'Play');
  play.click();
  try {
    await wait(() => newer.target.querySelector('#playback').textContent.includes('playing'));
  } catch (error) {
    throw Error(
      String(error) +
        ' status=' +
        newer.target.querySelector('#status').textContent +
        ' playback=' +
        newer.target.querySelector('#playback-debug').textContent,
    );
  }
  await reject(slot.close(), 'Workspace operation pending');
  need(slot.current() === newer && !newer.target.inert, 'Playback refusal lost owner');
  [...newer.target.querySelectorAll('button')].find((b) => b.textContent === 'Stop media').click();
  await wait(() => !newer.host.transitionState().busy);
  await slot.close();
  need(
    newer.host.live.originals.size === 0 && root.childElementCount === 0,
    'Close did not drain originals/root',
  );
  for (const owner of owners)
    if (owner.persistence) need(owner.closes === 1, 'Owner not closed exactly once: ' + owner.id);
  globalThis.console.log('mount stage', proofs.length);
  proofs.push('latest-candidate-and-close-drain');
  return {
    proofs,
    owners: owners.map((o) => ({ id: o.id, closes: o.closes, marks: o.marks.length })),
    namespaces,
  };
};
