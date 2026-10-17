import { mountV1Host, emptyV1 } from './host-v1';
import { validateHostV1 } from './capacity-v1';
import { time, videoCommandV1, validateVideoContentV1 } from '@editor-platform/video-core';
import { command } from '@editor-platform/editor-core';
const check = (v, message) => {
  if (!v) throw Error(message);
};
const same = (a, b, message) => check(JSON.stringify(a) === JSON.stringify(b), message);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const tick = () => new Promise((r) => globalThis.setTimeout(r, 0));
const until = async (predicate) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await tick();
  }
  throw Error('Test settlement timeout');
};
const codec = Object.fromEntries(
  ['preview', 'play', 'encode', 'verify'].map((name) => [
    name,
    async () => {
      throw Error('Codec not used in ownership tests');
    },
  ]),
);
const root = () => {
  const e = globalThis.document.createElement('section');
  globalThis.document.body.append(e);
  return e;
};
const storage = (
  write = async () => {
    throw Error('Unexpected test write');
  },
) => ({ key: 'same-artifact', settlementMs: 1000, write });
const activate = (el) => {
  const dt = new globalThis.DataTransfer();
  dt.items.add(new globalThis.File(['test'], 'candidate.zip'));
  const input = el.querySelector('#open');
  input.files = dt.files;
  input.dispatchEvent(new globalThis.Event('change'));
};
const clips = (n) => {
  const content = emptyV1();
  content.sequence.tracks = [{ id: 't', kind: 'visual', enabled: true, locked: false }];
  content.sequence.duration = time(n);
  content.sources = [
    {
      id: 's',
      asset: { assetId: 'a', sha256: 'a'.repeat(64), byteLength: 1 },
      streams: [
        {
          id: 'v',
          kind: 'video',
          timebase: time(1),
          startPts: 0,
          endPts: 1,
          presentationOrigin: time(0),
        },
      ],
    },
  ];
  content.sequence.clips = Array.from({ length: n }, (_, i) => ({
    id: 'c' + i,
    kind: 'video',
    sourceId: 's',
    streamId: 'v',
    trackId: 't',
    start: time(i),
    duration: time(1),
    sourceIn: time(0),
    sourceOut: time(1),
    rate: time(1),
  }));
  return content;
};
globalThis.reviewHostV1 = async () => {
  const proof = {};
  // Real scoped controller, injected storage seam only; these are not portable durability tests.
  let n = 1;
  while (validateHostV1(clips(n + 1))) n++;
  check(validateVideoContentV1(clips(n + 1)).valid, 'next native must remain valid');
  let invalidClosed = 0;
  try {
    await mountV1Host(
      root(),
      async () => ({
        storage: storage(),
        content: clips(n + 1),
        portable: async () => {
          throw Error();
        },
        close: async () => {
          invalidClosed++;
        },
      }),
      codec,
    );
    throw Error('Overflow root accepted');
  } catch (e) {
    check(String(e).includes('VideoHostControlledCapacityOrSchema'), 'root capacity refusal');
  }
  check(invalidClosed === 1, 'rejected root owner closed');
  const h = await mountV1Host(
    root(),
    async () => ({
      storage: storage(),
      content: clips(n),
      portable: async () => {
        throw Error();
      },
      close: async () => {},
    }),
    codec,
  );
  const rename = command('test.rename', 'rename', (c) => ({
    ...c,
    sequence: { ...c.sequence, id: 'renamed' },
  }));
  check(
    h.editor.execute({ baseRevision: h.read().revision, command: rename }).state === 'applied',
    'rename',
  );
  const future = h.read().content;
  h.editor.undo();
  const before = h.read();
  const split = h.editor.execute({
    baseRevision: before.revision,
    command: videoCommandV1({
      type: 'split',
      clipId: 'c0',
      at: time(1, 2),
      rightIds: { c0: 'right' },
    }),
  });
  check(split.state === 'refused', 'full view overflow must refuse');
  same(h.read(), before, 'capacity refusal mutates snapshot');
  check(h.editor.getSnapshot().state === 'open', 'capacity closes controller');
  check(h.editor.redo().state === 'applied', 'capacity erases pending redo');
  same(h.read().content, future, 'redo future');
  h.editor.undo();
  same(h.read().content, before.content, 'undo after refusal');
  await h.close();
  proof.capacity = { maxClips: n, refused: split.state, invalidClosed };
  // External close while Open awaits old persistence cleanup must await both owners, never resurrect B.
  const el = root(),
    release = deferred(),
    entered = deferred();
  let oldClosed = 0,
    newClosed = 0;
  const old = await mountV1Host(
    el,
    async (_live, file) => ({
      storage: storage(),
      content: emptyV1(),
      portable: async () => {
        throw Error();
      },
      close: async () => {
        if (file) {
          newClosed++;
        } else {
          oldClosed++;
          entered.resolve();
          await release.promise;
        }
      },
    }),
    codec,
  );
  const first = el.firstChild;
  activate(el);
  await entered.promise;
  let finished = false;
  const closing = old.close().then(() => {
    finished = true;
  });
  await tick();
  check(!finished, 'close returned before cleanup');
  release.resolve();
  await closing;
  check(el.firstChild === first, 'Host resurrected after close');
  check(oldClosed === 1 && newClosed === 1, 'owner cleanup not exact');
  proof.closeDuringOpen = { oldClosed, newClosed, finished };
  // An exposed non-UI command is refused while Open is preparing; its changed full view cancels Open.
  const el2 = root(),
    release2 = deferred();
  let candidateClosed = 0;
  const held = await mountV1Host(
    el2,
    async (_live, file) => {
      if (file) await release2.promise;
      return {
        storage: storage(),
        content: emptyV1(),
        portable: async () => {
          throw Error();
        },
        close: async () => {
          if (file) candidateClosed++;
        },
      };
    },
    codec,
  );
  held.editor.execute({ baseRevision: held.read().revision, command: rename });
  held.editor.undo();
  const heldBefore = held.read(),
    first2 = el2.firstChild;
  activate(el2);
  const refused = held.editor.execute({ baseRevision: held.read().revision, command: rename });
  check(refused.state === 'refused', 'non-UI mutation bypasses Open busy');
  release2.resolve();
  await until(() => candidateClosed === 1);
  same(held.read(), heldBefore, 'stale open loses current draft');
  check(el2.firstChild === first2, 'stale open replaces root');
  check(held.editor.redo().state === 'applied', 'stale open loses redo');
  await held.close();
  proof.staleOpen = { refused: refused.state, candidateClosed };
  // Input-generation changes must also cancel replacement without a native revision change.
  const el3 = root(),
    release3 = deferred();
  let staleInputsClosed = 0;
  const inputsHost = await mountV1Host(
    el3,
    async (_live, file) => {
      if (file) await release3.promise;
      return {
        storage: storage(),
        content: emptyV1(),
        portable: async () => {
          throw Error();
        },
        close: async () => {
          if (file) staleInputsClosed++;
        },
      };
    },
    codec,
  );
  const registration = inputsHost.editor.bindInputs({
    label: 'test',
    read: () => ({ dirty: false, composing: false }),
    prepare: (s) => ({ baseRevision: s.revision, command: null }),
    committed: () => {},
    focus: () => {},
  });
  const inputBefore = inputsHost.read();
  activate(el3);
  registration.changed();
  release3.resolve();
  await until(() => staleInputsClosed === 1);
  same(inputsHost.read(), inputBefore, 'input generation discarded draft');
  registration.unregister();
  await inputsHost.close();
  proof.staleInputs = { staleInputsClosed };
  // Unknown write evidence cannot transfer to a fresh coordinator or release originals.
  const el4 = root();
  let factories = 0,
    writes = 0,
    unknownClosed = 0,
    reconcileCalls = 0,
    captured,
    settled = false;
  const writeGate = deferred();
  const unknown = await mountV1Host(
    el4,
    async () => {
      factories++;
      return {
        storage: storage(async (request) => {
          writes++;
          captured = request;
          await writeGate.promise;
          return settled
            ? {
                state: 'committed',
                operationId: request.operationId,
                capture: request.capture,
                adapterReceiptId: 'injected-receipt',
              }
            : { state: 'unknown' };
        }),
        reconcile: async (operationId) => {
          check(operationId === captured.operationId, 'wrong reconciliation owner');
          if (++reconcileCalls === 1) return { state: 'unknown' };
          settled = true;
          return {
            state: 'committed',
            operationId,
            capture: captured.capture,
            adapterReceiptId: 'injected-receipt',
          };
        },
        content: emptyV1(),
        portable: async () => {
          throw Error();
        },
        close: async () => {
          unknownClosed++;
        },
      };
    },
    codec,
  );
  unknown.live.originals.set('retained', new globalThis.Blob(['retained']));
  const save = [...el4.querySelectorAll('button')].find(
    (b) => b.textContent === 'Save portable project',
  );
  const unknownSave = unknown.editor.save();
  await until(() => writes === 1);
  let closeRefused = false;
  const pendingClose = unknown.close().catch((e) => {
    check(String(e).includes('Unresolved Save'), 'pending close reason');
    closeRefused = true;
  });
  writeGate.resolve();
  await pendingClose;
  check(closeRefused, 'pending close falsely succeeds');
  const firstOutcome = await unknownSave;
  check(
    firstOutcome.state === 'outcome' && firstOutcome.outcome.state === 'indeterminate',
    'non-UI save outcome',
  );
  activate(el4);
  save.onclick();
  await tick();
  check(factories === 1 && writes === 1, 'unknown bypasses old claim');
  try {
    await unknown.close();
    throw Error('unknown close accepted');
  } catch (e) {
    check(String(e).includes('Unresolved Save'), 'unknown close reason');
  }
  check(
    unknownClosed === 0 && unknown.live.originals.size === 1,
    'unknown releases original ownership',
  );
  proof.unknown = { factories, writes, unknownClosed, originals: unknown.live.originals.size };
  try {
    await unknown.reconcileSave();
    throw Error('Unknown evidence falsely settled');
  } catch (e) {
    check(String(e).includes('remains indeterminate'), 'still unknown must retain');
  }
  check(
    unknown.live.originals.size === 1 && unknownClosed === 0,
    'unknown reconcile releases ownership',
  );
  await unknown.reconcileSave();
  const nextSave = await unknown.editor.save();
  check(
    nextSave.state === 'outcome' && nextSave.outcome.state === 'committed',
    'same coordinator claim not released by verified evidence',
  );
  const oldRoot = el4.firstChild;
  activate(el4);
  await until(() => el4.firstChild !== oldRoot);
  await unknown.close();
  check(
    factories === 2 && writes === 2 && unknownClosed === 2,
    'reconciled close/replacement ownership',
  );
  proof.reconciled = {
    factories,
    writes,
    unknownClosed,
    reconcileCalls,
    pendingCloseRefused: closeRefused,
  };
  // A has already activated B. A.close must neither disable B reconciliation nor poison retry.
  const chainRoot = root();
  let chainAClosed = 0,
    chainBClosed = 0,
    chainRequest;
  const chainA = await mountV1Host(
    chainRoot,
    async (_live, file) => ({
      storage: storage(async (request) => {
        chainRequest = request;
        return { state: 'unknown' };
      }),
      content: emptyV1(),
      portable: async () => {
        throw Error('No portable output in fault seam');
      },
      reconcile: async (operationId) => ({
        state: 'committed',
        operationId,
        capture: chainRequest.capture,
        adapterReceiptId: 'chain-injected-receipt',
      }),
      close: async () => {
        if (file) chainBClosed++;
        else chainAClosed++;
      },
    }),
    codec,
  );
  const firstChainRoot = chainRoot.firstChild;
  activate(chainRoot);
  await until(() => chainRoot.firstChild !== firstChainRoot);
  const chainButton = (name) =>
    [...chainRoot.querySelectorAll('button')].find((b) => b.textContent === name);
  chainButton('Save portable project').click();
  await until(() => chainRoot.querySelector('#status').textContent.includes('indeterminate'));
  try {
    await chainA.close();
    throw Error('Replacement unknown closed');
  } catch (e) {
    check(String(e).includes('Unresolved Save'), 'replacement unknown reason');
  }
  check(!chainButton('Reconcile save').disabled, 'A.close disabled B reconciliation');
  check(chainAClosed === 1 && chainBClosed === 0, 'A.close released unknown B');
  chainButton('Reconcile save').click();
  await until(() => chainRoot.querySelector('#status').textContent === 'Reconcile complete');
  await chainA.close();
  check(chainAClosed === 1 && chainBClosed === 1, 'A.close cannot retry after B reconciliation');
  proof.replacementUnknown = {
    chainAClosed,
    chainBClosed,
    reconciliationPreserved: true,
    originalCloseRetry: true,
  };
  return proof;
};
