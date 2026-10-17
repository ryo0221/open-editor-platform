import { expect, it } from 'vitest';
import { command, transaction } from '@editor-platform/editor-core';
import { createControlledSurfaceController } from '@editor-platform/extension-runtime/controlled';
import { ReferenceRegistry } from '@editor-platform/extension-runtime/draft2';
import {
  FakeStorage,
  ManualClock,
  referenceBinding,
  toyDefinition,
  toyManifest,
} from '@editor-platform/extension-runtime/reference';
import type { AtomicSurfaceInputs } from '@editor-platform/extension-contract/controlled-surface';
const create = (
  grants = ['artifact:read', 'artifact:edit', 'artifact:save'] as const,
  beforeMutation?: () => void,
) => {
  const clock = new ManualClock(),
    registry = new ReferenceRegistry(clock);
  const definition = toyDefinition({
    ...toyManifest,
    addons: {
      edit: { version: 'local-edit@0-draft', requirement: 'optional' },
      inputs: { version: 'inputs@0-draft', requirement: 'optional' },
      save: { version: 'local-persistence@0-draft', requirement: 'optional' },
      lifecycle: { version: 'lifecycle@0-draft', requirement: 'required' },
    },
  });
  const binding = referenceBinding({ value: 0 });
  binding.setGrants(grants);
  const storage = new FakeStorage<{ value: number }>('controlled');
  binding.storage = storage;
  const installed = registry.install(definition, {
    trust: 'trusted',
    verifiedPin: definition.manifest,
  });
  const open = () => {
    const opened = installed.open(binding);
    if (opened.state !== 'opened') throw new Error(opened.code);
    return opened.handle;
  };
  const handle = open(),
    errors: unknown[] = [];
  const controller = createControlledSurfaceController(handle.context, {
    beforeMutation,
    onError: (error) => errors.push(error),
  });
  const update = (value: number) => ({
    baseRevision: handle.context.basic.read().revision,
    command: command<{ value: number }>('set', 'Set', () => ({ value })),
  });
  return { controller, handle, binding, storage, registry, clock, open, errors, update };
};
it('one authority path for UI/non-UI, stale refusal, endpoint no-op, and revoke/new-readonly scope', () => {
  const h = create();
  expect(h.controller.getSnapshot()).toBe(h.controller.getSnapshot());
  const stale = h.update(99);
  expect(h.controller.execute(h.update(3))).toEqual({ state: 'applied' });
  expect(h.controller.execute(stale)).toMatchObject({ state: 'refused', code: 'StaleInput' });
  expect(h.controller.undo()).toEqual({ state: 'applied' });
  expect(h.controller.undo()).toEqual({ state: 'unchanged' });
  const view = h.controller.getSnapshot();
  expect(view.state).toBe('open');
  expect(h.controller.execute({ baseRevision: h.binding.session.revision, command: null })).toEqual(
    { state: 'unchanged' },
  );
  expect(h.binding.session.canRedo).toBe(true);
  expect(h.controller.redo()).toEqual({ state: 'applied' });
  h.binding.setGrants(['artifact:read']);
  expect(h.controller.getSnapshot()).toEqual({ state: 'revoked', code: 'ScopeRevoked' });
  expect(h.controller.execute(stale)).toMatchObject({ state: 'refused', code: 'ScopeRevoked' });
  const next = createControlledSurfaceController(h.open().context, { onError: () => {} });
  expect(next.getSnapshot()).toMatchObject({ state: 'open', canEdit: false, canSave: false });
  expect(next.execute({ baseRevision: h.binding.session.revision, command: null })).toMatchObject({
    state: 'refused',
    code: 'EditUnavailable',
  });
});
it('aggregate buffers commit once before save; pending/invalid/composition do not lose content or history', async () => {
  const h = create();
  let dirty = true,
    composing = true,
    invalid = false;
  const base = h.binding.session.revision;
  const group: AtomicSurfaceInputs<{ value: number }> = {
    label: 'all',
    read: () => ({ dirty, composing }),
    focus() {},
    prepare: () => {
      if (invalid) throw new Error('invalid-buffer');
      return {
        baseRevision: base,
        command: transaction('both', [
          command('a', 'a', () => ({ value: 2 })),
          command('b', 'b', (c) => ({ value: c.value + 3 })),
        ]),
      };
    },
    committed() {
      dirty = false;
    },
  };
  const registration = h.controller.bindInputs(group);
  expect(h.controller.undo()).toMatchObject({ code: 'PendingInputs' });
  expect(await h.controller.save()).toMatchObject({ state: 'refused' });
  expect(h.storage.requests).toHaveLength(0);
  composing = false;
  invalid = true;
  registration.changed();
  expect(h.controller.applyInputs()).toMatchObject({ state: 'refused' });
  expect(h.binding.session.content.value).toBe(0);
  expect(h.binding.session.canUndo).toBe(false);
  invalid = false;
  registration.changed();
  const result = h.controller.save();
  const request = await h.storage.nextRequest();
  expect(request.content.value).toBe(5);
  expect(dirty).toBe(false);
  // Later edits must not be advertised as included in the acknowledged capture.
  h.controller.execute(h.update(9));
  h.storage.commit(request.operationId);
  expect(await result).toMatchObject({
    state: 'outcome',
    outcome: { state: 'committed', capture: request.capture },
  });
  expect(h.binding.session.content.value).toBe(9);
  expect(h.storage.writes[0].content.value).toBe(5);
  h.controller.undo();
  expect(h.binding.session.content.value).toBe(5);
  h.controller.undo();
  expect(h.binding.session.content.value).toBe(0);
});
it('preflight never admits reentrant execute and changes after preflight refuse atomically', () => {
  const h = create();
  let changed = () => {},
    prepared = false;
  h.controller.bindInputs({
    label: 'all',
    read: () => ({ dirty: true, composing: false }),
    focus() {},
    committed() {},
    prepare(snapshot) {
      expect(h.controller.execute(h.update(4))).toMatchObject({ code: 'SurfaceReentrancy' });
      prepared = true;
      return { baseRevision: snapshot.revision, command: command('a', 'a', () => ({ value: 8 })) };
    },
  });
  // A different Host boundary can change this buffer after all prepares, before its commit.
  const h2 = create();
  const registration = h2.controller.bindInputs({
    label: 'all',
    read: () => ({ dirty: true, composing: false }),
    focus() {},
    committed() {},
    prepare(snapshot) {
      return { baseRevision: snapshot.revision, command: command('a', 'a', () => ({ value: 8 })) };
    },
  });
  changed = registration.changed;
  h2.binding.inputs.register({
    label: 'other',
    read: () => ({ dirty: true }),
    prepare() {
      changed();
      return () => {};
    },
    focus() {},
  });
  expect(() => h2.binding.inputs.flush()).toThrow('InputChanged');
  expect(h2.binding.session.content.value).toBe(0);
  expect(h.controller.applyInputs()).toEqual({ state: 'applied' });
  expect(prepared).toBe(true);
});
it('authority can disappear in beforeMutation without canonical commit', () => {
  let revoke = () => {};
  const h = create(undefined, () => revoke());
  revoke = () => h.handle.revoke('host-close');
  expect(h.controller.execute(h.update(3))).toMatchObject({
    state: 'refused',
    code: 'ScopeRevoked',
  });
  expect(h.binding.session.content.value).toBe(0);
  expect(h.binding.session.canUndo).toBe(false);
});
it('uncertain and aborted saves stay distinct', async () => {
  const h = create();
  const pending = h.controller.save(),
    req = await h.storage.nextRequest();
  h.storage.noWrite(req.operationId);
  expect(await pending).toMatchObject({
    state: 'outcome',
    outcome: { state: 'aborted-before-write' },
  });
  const unknown = h.controller.save(),
    req2 = await h.storage.nextRequest();
  h.storage.fail(req2.operationId);
  expect(await unknown).toMatchObject({ state: 'outcome', outcome: { state: 'indeterminate' } });
  expect(await h.controller.save()).toMatchObject({ state: 'refused', code: 'SaveBusy' });
});
it('observer failures never disguise a committed command and remain visible in drain', async () => {
  const h = create();
  h.controller.subscribe(() => {
    throw new Error('observer-failed');
  });
  expect(h.controller.execute(h.update(7))).toEqual({ state: 'applied' });
  expect(h.binding.session.content.value).toBe(7);
  expect(h.errors).toHaveLength(1);
  h.handle.revoke('host-close');
  await Promise.resolve();
  expect(await h.handle.drain({ deadlineMs: 0 })).toMatchObject({ state: 'incomplete' });
});
it('direct Apply refreshes Input flags so Save does not prepare the same buffers twice', async () => {
  const h = create();
  let dirty = true,
    prepared = 0;
  h.controller.bindInputs({
    label: 'all',
    read: () => ({ dirty, composing: false }),
    focus() {},
    prepare(snapshot) {
      prepared++;
      return {
        baseRevision: snapshot.revision,
        command: command('set', 'Set', () => ({ value: 6 })),
      };
    },
    committed() {
      dirty = false;
    },
  });
  expect(h.controller.applyInputs()).toEqual({ state: 'applied' });
  expect(h.errors).toEqual([]);
  const saved = h.controller.save(),
    request = await h.storage.nextRequest();
  h.storage.commit(request.operationId);
  await saved;
  expect(prepared).toBe(1);
  expect(h.binding.session.revision.sequence).toBe(1);
});
it.each(['execute', 'undo', 'redo'] as const)(
  'rechecks pending inputs after beforeMutation for %s',
  (action) => {
    let before = () => {};
    const h = create(undefined, () => before());
    h.controller.execute(h.update(1));
    if (action === 'redo') h.controller.undo();
    let dirty = false;
    const registration = h.controller.bindInputs({
      label: 'all',
      read: () => ({ dirty, composing: false }),
      prepare: () => ({ baseRevision: h.binding.session.revision, command: null }),
      committed() {},
      focus() {},
    });
    before = () => {
      dirty = true;
      registration.changed();
    };
    const previous = h.binding.session.revision,
      value = h.binding.session.content.value,
      undo = h.binding.session.canUndo,
      redo = h.binding.session.canRedo;
    const result =
      action === 'execute' ? h.controller.execute(h.update(2)) : h.controller[action]();
    expect(result.state).toBe('refused');
    expect(h.binding.session.revision).toEqual(previous);
    expect(h.binding.session.content.value).toBe(value);
    expect(h.binding.session.canUndo).toBe(undo);
    expect(h.binding.session.canRedo).toBe(redo);
  },
);
it.each(['execute', 'undo', 'redo'] as const)(
  'checks composing and clean sequence changes after %s pre-mutation',
  (action) => {
    for (const mode of ['composing', 'clean-sequence'] as const) {
      let before = () => {};
      const h = create(undefined, () => before());
      h.controller.execute(h.update(1));
      if (action === 'redo') h.controller.undo();
      let composing = false;
      const registration = h.controller.bindInputs({
        label: 'all',
        read: () => ({ dirty: false, composing }),
        prepare: () => ({ baseRevision: h.binding.session.revision, command: null }),
        committed() {},
        focus() {},
      });
      before = () => {
        composing = mode === 'composing';
        if (mode === 'clean-sequence') registration.changed();
      };
      const previous = h.binding.session.revision,
        value = h.binding.session.content.value,
        undo = h.binding.session.canUndo,
        redo = h.binding.session.canRedo;
      const result =
        action === 'execute' ? h.controller.execute(h.update(2)) : h.controller[action]();
      expect(result).toMatchObject({
        state: 'refused',
        code: mode === 'composing' ? 'PendingInputs' : 'InputChanged',
      });
      expect(h.binding.session.revision).toEqual(previous);
      expect(h.binding.session.content.value).toBe(value);
      expect(h.binding.session.canUndo).toBe(undo);
      expect(h.binding.session.canRedo).toBe(redo);
    }
  },
);
it('permits ordinary pause/capture callback with unchanged buffers, revision and scope', () => {
  let calls = 0;
  const h = create(undefined, () => {
    calls++;
  });
  h.controller.bindInputs({
    label: 'all',
    read: () => ({ dirty: false, composing: false }),
    prepare: () => ({ baseRevision: h.binding.session.revision, command: null }),
    committed() {},
    focus() {},
  });
  expect(h.controller.execute(h.update(2))).toEqual({ state: 'applied' });
  expect(h.controller.undo()).toEqual({ state: 'applied' });
  expect(h.controller.redo()).toEqual({ state: 'applied' });
  expect(h.binding.session.content.value).toBe(2);
  expect(calls).toBe(3);
});
