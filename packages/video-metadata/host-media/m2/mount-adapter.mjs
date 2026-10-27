/** Private Video-owned bridge. Registration, locators and publication remain caller-owned. */
import { mountV2Host } from './host-v2';

export async function prepareV2Workspace({
  factory,
  codec,
  file,
  assertCanLeave,
  mountHost = mountV2Host,
}) {
  if (typeof assertCanLeave !== 'function') throw Error('Host leave guard required');
  const target = globalThis.document.createElement('section');
  let epoch = 0;
  for (const event of ['input', 'change', 'compositionstart', 'compositionend'])
    target.addEventListener(
      event,
      () => {
        epoch++;
      },
      true,
    );
  const host = await mountHost(target, factory, codec, file, { externalSwitching: true });
  let disposed = false;
  try {
    const initialHash = (await host.snapshot()).hash;
    const pin = () =>
      JSON.stringify([
        host.editor.getSnapshot(),
        epoch,
        host.transitionState(),
        [...target.querySelectorAll('input,select,textarea')].map((node) => [
          node.id,
          node.value,
          node.checked,
        ]),
      ]);
    const ready = () => {
      const state = host.transitionState();
      if (disposed) throw Error('Workspace disposed');
      if (state.busy || host.editor.getSnapshot().saving)
        throw Error('Workspace operation pending');
      if (state.unresolvedSave) throw Error('Unresolved Save retains workspace');
      if (state.durationDirty) throw Error('Apply or reset duration before leaving');
    };
    return {
      target,
      host,
      pin,
      async guard() {
        target.inert = true;
        try {
          ready();
          const inputs = host.editor.applyInputs();
          if (inputs.state === 'refused') throw Error(inputs.message);
          const before = pin(),
            snapshot = await host.snapshot();
          await assertCanLeave({ snapshot, initialHash, fromPortable: !!file });
          ready();
          if (before !== pin()) throw Error('Workspace changed during handoff');
          return before;
        } catch (error) {
          target.inert = false;
          throw error;
        }
      },
      resume() {
        if (!disposed) target.inert = false;
      },
      async dispose() {
        if (disposed) return;
        await host.close();
        disposed = true;
      },
    };
  } catch (error) {
    await host.close();
    throw error;
  }
}

/** Candidate preparation may overlap; commit/disposal has exactly one owner. */
export function createV2MountSlot(root) {
  let current,
    generation = 0,
    commitOwner,
    closing,
    closed = false;
  const pending = new Set();
  function replace(options) {
    if (closed || closing || commitOwner)
      return Promise.reject(Error('Workspace handoff unavailable'));
    const ticket = ++generation,
      previous = current,
      before = previous?.pin();
    const job = (async () => {
      const candidate = await prepareV2Workspace(options);
      let activated = false;
      const token = Symbol('replace');
      const valid = () => {
        if (
          closed ||
          closing ||
          commitOwner !== token ||
          ticket !== generation ||
          current !== previous
        )
          throw Error('Stale workspace commit');
      };
      try {
        // Recheck ownership after preparation, including the initially empty slot.
        if (
          closed ||
          closing ||
          commitOwner ||
          ticket !== generation ||
          current !== previous ||
          previous?.pin() !== before
        )
          throw Error('Stale workspace candidate');
        commitOwner = token;
        try {
          const guarded = await previous?.guard();
          valid();
          if (previous && previous.pin() !== guarded)
            throw Error('Workspace changed before commit');
          await previous?.dispose();
          valid();
          current = candidate;
          root.replaceChildren(candidate.target);
          activated = true;
          return candidate;
        } catch (error) {
          previous?.resume();
          throw error;
        } finally {
          if (commitOwner === token) commitOwner = undefined;
        }
      } finally {
        if (!activated) await candidate.dispose();
      }
    })();
    pending.add(job);
    job.then(
      () => pending.delete(job),
      () => pending.delete(job),
    );
    return job;
  }
  function close() {
    if (closing) return closing;
    if (commitOwner) return Promise.reject(Error('Workspace handoff pending'));
    if (closed) return Promise.resolve();
    const token = Symbol('close'),
      previous = current;
    commitOwner = token;
    // Invalidate all preparers before the first await, even if guard later refuses.
    generation++;
    const valid = () => {
      if (commitOwner !== token || current !== previous) throw Error('Stale close owner');
    };
    // Publish the shared promise before invoking reentrant guard/disposal callbacks.
    closing = Promise.resolve().then(async () => {
      try {
        await previous?.guard();
        valid();
        await previous?.dispose();
        valid();
        closed = true;
        await Promise.allSettled([...pending]);
        valid();
        current = undefined;
        root.replaceChildren();
      } catch (error) {
        if (!closed) {
          previous?.resume();
          closing = undefined;
        }
        throw error;
      } finally {
        if (commitOwner === token) commitOwner = undefined;
      }
    });
    return closing;
  }
  return { replace, current: () => current, close };
}
