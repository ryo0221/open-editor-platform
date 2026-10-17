import { expect, it } from 'vitest';
import { disposeGuarded } from './navigation';

it('restores reconciliation controls when same-content unresolved Save refuses close', async () => {
  let inert = false;
  let unresolved = true;
  let released = false;
  const owner = {
    async guard() {
      inert = true;
    },
    async dispose() {
      if (unresolved) throw Error('UnresolvedSave');
      released = true;
    },
    resume() {
      inert = false;
    },
  };
  await expect(disposeGuarded(owner)).rejects.toThrow('UnresolvedSave');
  expect(inert).toBe(false);
  expect(released).toBe(false);
  unresolved = false;
  await disposeGuarded(owner);
  expect(released).toBe(true);
});
