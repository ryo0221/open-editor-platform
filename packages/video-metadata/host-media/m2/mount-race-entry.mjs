import { createV2MountSlot } from './mount-adapter.mjs';
import { emptyV2 } from './host-v2';
const defer = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const tick = () => new Promise((r) => globalThis.setTimeout(r, 0));
const wait = async (test) => {
  for (let i = 0; i < 500; i++) {
    if (test()) return;
    await tick();
  }
  throw Error('Interleaving not reached');
};
const outcome = (job) =>
  job.then(
    () => ({ state: 'fulfilled' }),
    (e) => ({ state: 'rejected', error: String(e) }),
  );
globalThis.runMountRaces = async () => {
  const results = [];
  function setup() {
    const root = globalThis.document.createElement('main');
    globalThis.document.body.append(root);
    const slot = createV2MountSlot(root),
      owners = [];
    function options(id, { prepare, guard, close } = {}) {
      const owner = { id, prepared: 0, guards: 0, closes: 0 };
      owners.push(owner);
      return {
        codec: { preview: async () => {} },
        factory: async () => {
          if (prepare) await prepare.promise;
          owner.prepared++;
          return {
            content: emptyV2(),
            close: async () => {
              owner.closes++;
              if (close) await close.promise;
            },
          };
        },
        assertCanLeave: async () => {
          owner.guards++;
          if (guard) await guard.promise;
        },
      };
    }
    return { root, slot, owners, options };
  }
  // Prepare completes while close is in an async leave guard and old disposal is deferred.
  {
    const { root, slot, owners, options } = setup(),
      guard = defer(),
      close = defer(),
      prepare = defer();
    const a = await slot.replace(options('a', { close }));
    // Controlled stable guard isolates slot ownership from controller notifications.
    a.pin = () => 'stable';
    a.guard = async () => {
      owners[0].guards++;
      await guard.promise;
      return 'stable';
    };
    const replacing = outcome(slot.replace(options('b', { prepare }))),
      closing = outcome(slot.close());
    await wait(() => owners[0].guards === 1);
    prepare.resolve();
    await wait(() => owners[1].prepared === 1);
    // Let the real candidate snapshot settle and attempt commit while close holds the guard.
    for (let i = 0; i < 8; i++) await tick();
    guard.resolve();
    await wait(() => owners[0].closes === 1);
    close.resolve();
    const [replacement, closed] = await Promise.all([replacing, closing]);
    const pass =
      replacement.state === 'rejected' &&
      closed.state === 'fulfilled' &&
      owners[1].closes === 1 &&
      root.childElementCount === 0;
    results.push({ id: 'close-guard-prepare-race', pass, replacement, closed, owners });
    root.remove();
  }
  // Every close caller must share the complete pending-candidate drain.
  {
    const { root, slot, owners, options } = setup(),
      prepare = defer();
    await slot.replace(options('a'));
    const replacement = outcome(slot.replace(options('b', { prepare })));
    const first = slot.close();
    await wait(() => owners[0].closes === 1);
    for (let i = 0; i < 8; i++) await tick();
    let secondSettled = false;
    const second = slot.close();
    const secondResult = second.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );
    for (let i = 0; i < 8; i++) await tick();
    const early = secondSettled,
      shared = first === second;
    prepare.resolve();
    await Promise.all([first, secondResult, replacement]);
    results.push({
      id: 'shared-close-drain',
      pass: !early && shared && owners[1].closes === 1 && root.childElementCount === 0,
      early,
      shared,
      owners,
    });
    root.remove();
  }
  // Close invalidates even an initial mount that has no previous workspace.
  {
    const { root, slot, owners, options } = setup(),
      prepare = defer();
    const replacement = outcome(slot.replace(options('initial', { prepare })));
    const first = slot.close(),
      second = slot.close();
    prepare.resolve();
    const resultsClose = await Promise.all([outcome(first), outcome(second)]),
      replaced = await replacement;
    results.push({
      id: 'initial-mount-close',
      pass:
        first === second &&
        resultsClose.every((r) => r.state === 'fulfilled') &&
        replaced.state === 'rejected' &&
        owners[0].closes === 1 &&
        root.childElementCount === 0,
      replaced,
      resultsClose,
      owners,
    });
    root.remove();
  }
  // A replace already committing owns old disposal exclusively; a refused close may retry afterward.
  {
    const { root, slot, owners, options } = setup(),
      close = defer();
    await slot.replace(options('a', { close }));
    const replacement = outcome(slot.replace(options('b')));
    await wait(() => owners[0].closes === 1);
    const refused = await outcome(slot.close());
    close.resolve();
    const replaced = await replacement;
    await slot.close();
    results.push({
      id: 'replace-disposal-exclusive',
      pass:
        refused.state === 'rejected' &&
        replaced.state === 'fulfilled' &&
        owners.every((o) => o.closes === 1) &&
        root.childElementCount === 0,
      refused,
      replaced,
      owners,
    });
    root.remove();
  }
  return results;
};
