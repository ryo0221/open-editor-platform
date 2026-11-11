/**
 * Cross-tab coordination of this Host's package store (#500 E2).
 *
 * Every page of this Host on the same origin registers its presence for its lifetime with its own
 * Web Lock (`…page.<id>`), because its open Editor and loaded packages come from the shared
 * store. Every change to the store (start-up load and cleanup, retaining, removing) runs under one
 * exclusive `…changes` lock. A page registers its presence before it waits for that lock, so
 * inside it every page that has loaded or is loading packages is visible: `alone` is true only
 * when this is the only page. Pages are never hidden to take the lock, so concurrent removals
 * cannot see each other as absent. Installs run only under the lock, so a staged record seen
 * under it is never another tab's install in progress. Without Web Locks nothing is coordinated
 * and the page is never treated as alone.
 */
const PREFIX = 'extension-reference.packages.';
const PAGE = `${PREFIX}page.`;
const CHANGES = `${PREFIX}changes`;

export function packageStoreLock() {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  const presence = PAGE + crypto.randomUUID();
  let joined: Promise<void> | undefined;
  /** Registers this page for its lifetime (released when the page goes away). */
  function join() {
    if (!locks) return Promise.resolve();
    joined ??= new Promise<void>((granted) => {
      void locks.request(presence, { mode: 'exclusive' }, () => {
        granted();
        return new Promise<never>(() => undefined);
      });
    });
    return joined;
  }
  /** Runs one store change under the shared change lock; `alone` as described above. */
  async function change<T>(run: (alone: boolean) => Promise<T>): Promise<T> {
    if (!locks) return run(false);
    await join();
    return locks.request(CHANGES, { mode: 'exclusive' }, async () => {
      const { held = [] } = await locks.query();
      const pages = new Set(held.map((l) => l.name).filter((n) => n?.startsWith(PAGE)));
      return run(pages.size === 1 && pages.has(presence));
    });
  }
  return { coordinated: !!locks, join, change };
}
