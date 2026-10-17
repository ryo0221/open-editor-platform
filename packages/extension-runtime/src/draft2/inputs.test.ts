import { it, expect, vi } from 'vitest';
import { command, type EditorInputBoundary } from '@editor-platform/editor-core';
import { api, harness, admitted, setValue } from './harness';
import { ReferenceRegistry } from '../draft2';
import { FakeStorage, ManualClock, referenceBinding, toyDefinition } from './reference';
import type {
  InputCheckpoint,
  LocalReadSnapshot,
} from '@editor-platform/extension-contract/draft2';
function buffer(h: ReturnType<typeof harness>, id = 'buffer', value = 1) {
  let base = h.handle.context.basic.read();
  let dirty = true;
  let composing = false;
  let failure = false;
  let draft = value;
  const focus = vi.fn();
  const prepare = vi.fn(() => {
    if (failure) throw new Error('invalid');
    return () => {
      api(h.handle, 'edit').execute(setValue(draft));
      dirty = false;
    };
  });
  const boundary: EditorInputBoundary = {
    label: id,
    read: () => ({ dirty, composing }),
    prepare,
    focus,
  };
  const registration = api(h.handle, 'inputs').register(id, boundary);
  const checkpoint = (sequence = 0): InputCheckpoint => ({
    sequence,
    baseRevision: base.revision,
    codec: { id: 'toy', version: '1' },
    payload: { value: draft },
  });
  return {
    registration,
    checkpoint,
    prepare,
    focus,
    composing: () => {
      composing = true;
      registration.changed(0);
    },
    fail: () => {
      failure = true;
    },
    rebase: (
      snapshot: LocalReadSnapshot<{ value: number }>,
      reconcile: (current: number, canonical: number) => number,
    ) => {
      const result = reconcile(draft, snapshot.content.value);
      draft = result;
      base = snapshot;
    },
    base: () => base,
  };
}
it('I01 two existing inputs flush and capture post-command revision', async () => {
  const h = harness();
  buffer(h, 'a', 1);
  buffer(h, 'b', 2);
  const result = api(h.handle, 'save').save();
  const id = await admitted(h);
  expect(h.storage.requests[0]).toMatchObject({
    content: { value: 2 },
    capture: { revision: { sequence: 2 } },
  });
  expect(h.binding.inputs.getSnapshot().dirty).toBe(0);
  h.storage.commit(id);
  await result;
  api(h.handle, 'edit').undo();
  expect(h.handle.context.basic.read().content.value).toBe(1);
});
it.each(['composing', 'invalid'] as const)(
  'I02 %s blocks save and normal close before writes',
  async (state) => {
    const h = harness();
    const b = buffer(h);
    if (state === 'composing') b.composing();
    else b.fail();
    await expect(api(h.handle, 'save').save()).rejects.toThrow();
    expect(h.handle.requestClose()).toMatchObject({ state: 'blocked', reason: 'input' });
    expect(h.handle.context.basic.read().content.value).toBe(0);
    expect(b.focus).toHaveBeenCalled();
    expect(h.storage.requests).toHaveLength(0);
  },
);
it('I03 partial flush retains earlier legal command without global rollback', async () => {
  const h = harness();
  buffer(h, 'a', 1);
  api(h.handle, 'inputs').register('b', {
    label: 'b',
    read: () => ({ dirty: true }),
    prepare: () => () => false,
    focus: () => {},
  });
  await expect(api(h.handle, 'save').save()).rejects.toThrow();
  expect(h.handle.context.basic.read().content.value).toBe(1);
  expect(h.binding.session.canUndo).toBe(true);
  expect(h.binding.inputs.getSnapshot().dirty).toBeGreaterThan(0);
  expect(h.storage.requests).toHaveLength(0);
});
it('I04/N08 save-only clean allowed; dirty flush never borrows edit', async () => {
  const definition = toyDefinition();
  definition.manifest.permissions = ['artifact:read', 'artifact:save'];
  definition.manifest.addons = {
    lifecycle: { version: 'lifecycle@0-draft', requirement: 'required' },
    save: { version: 'local-persistence@0-draft', requirement: 'required' },
  };
  const binding = referenceBinding({ value: 1 });
  binding.setGrants(['artifact:read', 'artifact:save']);
  const storage = new FakeStorage<{ value: number }>('save-only');
  binding.storage = storage;
  const result = new ReferenceRegistry(new ManualClock())
    .install(definition, { trust: 'trusted', verifiedPin: definition.manifest })
    .open(binding);
  if (result.state !== 'opened') throw new Error();
  const saved = api(result.handle, 'save').save();
  if (!storage.requests.length) await storage.nextRequest();
  storage.commit(storage.requests[0].operationId);
  await saved;
  const prepare = vi.fn();
  binding.inputs.register({
    label: 'host-buffer',
    read: () => ({ dirty: true }),
    prepare,
    focus: () => {},
  });
  await expect(api(result.handle, 'save').save()).rejects.toThrow('PermissionDenied');
  expect(prepare).not.toHaveBeenCalled();
  expect(storage.requests).toHaveLength(1);
});
it('I05/I08 stale latest checkpoint survives force detach without serialize/flush', () => {
  const h = harness();
  const b = buffer(h);
  expect(b.registration.checkpoint(b.checkpoint())).toEqual({ state: 'retained', sequence: 0 });
  b.registration.changed(1);
  const ticket = h.handle.revoke('permission-expired');
  expect(ticket.recovery).toEqual([{ boundaryId: 'buffer', state: 'stale', sequence: 0 }]);
  expect(b.prepare).not.toHaveBeenCalled();
  b.registration.unregister();
  b.registration.unregister();
  expect(b.registration.checkpoint(b.checkpoint(1))).toEqual({
    state: 'refused',
    reason: 'revoked',
  });
  expect(() =>
    api(h.handle, 'inputs').register('late', {
      label: 'late',
      read: () => ({ dirty: true }),
      prepare: () => () => {},
      focus: () => {},
    }),
  ).toThrow('ScopeRevoked');
  expect(h.registry.recovery.inspect(h.handle.scope, 'buffer')?.checkpoint.sequence).toBe(0);
});
it.each(['missing', 'policy-denied', 'discarded-by-policy', 'ttl'] as const)(
  'I06 %s remains observable and never saves',
  (state) => {
    const h = harness();
    if (state === 'discarded-by-policy') h.binding.recovery!.onRevoke = 'discard';
    const b = buffer(h);
    if (state === 'policy-denied')
      b.registration.checkpoint({ ...b.checkpoint(), codec: { id: 'bad', version: '1' } });
    if (state === 'ttl') {
      b.registration.checkpoint(b.checkpoint());
      h.clock.advanceTo(1001);
    }
    expect(h.handle.revoke('host-close').recovery[0].state).toBe(
      state === 'ttl' ? 'missing' : state,
    );
    expect(h.storage.requests).toHaveLength(0);
  },
);
it.each(['codec', 'json', 'large', 'sequence', 'session'] as const)(
  'I07 invalid %s does not overwrite last good',
  (kind) => {
    const h = harness();
    const b = buffer(h);
    b.registration.checkpoint(b.checkpoint());
    const checkpoint = b.checkpoint();
    if (kind === 'codec') checkpoint.codec = { ...checkpoint.codec, id: 'no' };
    if (kind === 'json')
      checkpoint.payload = { x: undefined } as unknown as InputCheckpoint['payload'];
    if (kind === 'large') checkpoint.payload = 'x'.repeat(3000);
    if (kind === 'sequence') checkpoint.sequence = -1;
    if (kind === 'session')
      checkpoint.baseRevision = { ...checkpoint.baseRevision, sessionId: 'foreign' };
    expect(b.registration.checkpoint(checkpoint).state).toBe('refused');
    expect(h.registry.recovery.inspect(h.handle.scope, 'buffer')?.checkpoint).toEqual(
      b.checkpoint(),
    );
  },
);
it('I09/I10 recovery is separately authorized, rejects conflict and applies ordinary Undo command', () => {
  const h = harness();
  const b = buffer(h);
  b.registration.checkpoint(b.checkpoint());
  h.handle.revoke('replace');
  const current = h.open();
  const recover = (artifactId = current.scope.artifactId, denied = false) =>
    h.registry.recovery.apply({
      oldScope: h.handle.scope,
      boundaryId: 'buffer',
      newScope: { ...current.scope, artifactId },
      policy: h.binding.recovery!,
      revision: current.context.basic.read().revision,
      check: () => {
        if (denied) throw new Error('denied');
        api(current, 'lifecycle').assertCurrent();
      },
      command: (payload) => command('restore', 'Restore', () => payload as { value: number }),
      execute: (cmd) => api(current, 'edit').execute(cmd),
    });
  expect(() => recover('other')).toThrow('RecoveryScope');
  expect(() => recover(undefined, true)).toThrow('denied');
  recover();
  expect(current.context.basic.read().content.value).toBe(1);
  api(current, 'edit').undo();
  expect(current.context.basic.read().content.value).toBe(0);
  expect(() => recover()).toThrow('RecoveryConflict');
});
it('I11 ordinary dirty unregister refuses, flush then unregister succeeds', () => {
  const h = harness();
  const b = buffer(h);
  expect(() => b.registration.unregister()).toThrow('DirtyInput');
  h.binding.inputs.flush();
  b.registration.unregister();
  expect(h.binding.inputs.getSnapshot().dirty).toBe(0);
});
it('I12 original r1 checkpoint remains stale after r2 without save grant or raw Host', () => {
  const h = harness(['artifact:read', 'artifact:edit']);
  const b = buffer(h);
  const r1 = b.base().revision;
  api(h.handle, 'edit').execute(setValue(2));
  h.handle.context.basic.read();
  expect(b.registration.checkpoint(b.checkpoint()).state).toBe('retained');
  const retained = h.registry.recovery.inspect(h.handle.scope, 'buffer')!;
  expect(retained.checkpoint.baseRevision).toEqual(r1);
  expect(h.handle.revoke('replace').recovery[0].state).toBe('stale');
  expect(h.storage.requests).toHaveLength(0);
});
it('I13 buffer changes base only after successful explicit reconciliation', () => {
  const h = harness();
  const b = buffer(h);
  api(h.handle, 'edit').execute(setValue(2));
  const r2 = h.handle.context.basic.read();
  const before = b.checkpoint();
  expect(() =>
    b.rebase(r2, () => {
      throw new Error('conflict');
    }),
  ).toThrow('conflict');
  expect(b.checkpoint()).toEqual(before);
  b.rebase(r2, (draft, canonical) => draft + canonical);
  b.registration.changed(1);
  expect(b.registration.checkpoint(b.checkpoint(1)).state).toBe('retained');
  expect(b.checkpoint(1)).toMatchObject({ baseRevision: r2.revision, payload: { value: 3 } });
});
it('I14 snapshot detaches content, freezes scope/revision, and refuses intervening mutation/revoke', () => {
  const h = harness();
  const snapshot = h.handle.context.basic.read();
  snapshot.content.value = 99;
  expect(h.handle.context.basic.read().content.value).toBe(0);
  expect(Object.isFrozen(snapshot.revision)).toBe(true);
  expect(Object.isFrozen(snapshot.scope)).toBe(true);
  api(h.handle, 'edit').execute(setValue(2));
  expect(h.handle.context.basic.read()).toMatchObject({
    content: { value: 2 },
    revision: { sequence: 1 },
  });
  h.binding.setGrants([]);
  expect(() => h.handle.context.basic.read()).toThrow('ScopeRevoked');
});
it('I14 linearization rejects canonical mutation or permission expiry during validation', () => {
  const h = harness();
  const validate = h.definition.validate;
  let mutated = false;
  h.definition.validate = (value): value is { value: number } => {
    if (!mutated) {
      mutated = true;
      h.binding.session.execute(setValue(7));
    }
    return validate(value);
  };
  expect(() => h.handle.context.basic.read()).toThrow('ReadConflict');
  expect(h.handle.context.basic.read()).toMatchObject({
    content: { value: 7 },
    revision: { sequence: 1 },
  });
  h.definition.validate = (value): value is { value: number } => {
    h.binding.setGrants([]);
    return validate(value);
  };
  expect(() => h.handle.context.basic.read()).toThrow('ScopeRevoked');
});
it('N08/I03/S13 permission loss inside command computation cannot commit or dispatch', async () => {
  const h = harness();
  expect(() =>
    api(h.handle, 'edit').execute(
      command('revoking', 'Revoking', () => {
        h.binding.setGrants(['artifact:read']);
        return { value: 99 };
      }),
    ),
  ).toThrow('ScopeRevoked');
  expect(h.binding.session.content).toEqual({ value: 0 });
  expect(h.binding.session.canUndo).toBe(false);
  expect(h.storage.requests).toHaveLength(0);
});
it('I08 register notification revocation detaches pending registration before reopening', () => {
  const h = harness();
  const inputs = api(h.handle, 'inputs');
  const prepare = vi.fn(() => () => {});
  const stop = h.binding.inputs.subscribe(() => {
    if (h.binding.inputs.getSnapshot().dirty) h.handle.revoke('replace');
  });
  expect(() =>
    inputs.register('racing', {
      label: 'racing',
      read: () => ({ dirty: true }),
      prepare,
      focus: () => {},
    }),
  ).toThrow('ScopeRevoked');
  stop();
  expect(h.binding.inputs.getSnapshot().dirty).toBe(0);
  const reopened = h.open();
  expect(reopened.requestClose().state).toBe('revoked');
  expect(prepare).not.toHaveBeenCalled();
});
it('I08 throwing register notification rolls back and allows same-id retry', () => {
  const h = harness();
  const inputs = api(h.handle, 'inputs');
  const stop = h.binding.inputs.subscribe(() => {
    throw new Error('register notification');
  });
  const prepare = vi.fn(() => () => {});
  const boundary = { label: 'retry', read: () => ({ dirty: true }), prepare, focus: () => {} };
  expect(() => inputs.register('retry', boundary)).toThrow(
    'Input registration rollback notification failed',
  );
  stop();
  expect(h.binding.inputs.getSnapshot().dirty).toBe(0);
  expect(() => inputs.register('retry', boundary)).not.toThrow();
  h.handle.revoke('replace');
  expect(h.binding.inputs.getSnapshot().dirty).toBe(0);
  expect(h.open().requestClose().state).toBe('revoked');
  expect(prepare).not.toHaveBeenCalled();
});
it('I08 revoke then throw during registration leaves no stale boundary', () => {
  const h = harness();
  const inputs = api(h.handle, 'inputs');
  const stop = h.binding.inputs.subscribe(() => {
    if (h.binding.inputs.getSnapshot().dirty) {
      h.handle.revoke('replace');
      throw new Error('after revoke');
    }
  });
  expect(() =>
    inputs.register('race', {
      label: 'race',
      read: () => ({ dirty: true }),
      prepare: () => () => {},
      focus: () => {},
    }),
  ).toThrow('after revoke');
  stop();
  expect(h.binding.inputs.getSnapshot().dirty).toBe(0);
  expect(h.open().requestClose().state).toBe('revoked');
});
it('I08 initial read cannot register a second boundary with the reserved id', () => {
  const h = harness();
  const inputs = api(h.handle, 'inputs');
  const boundary = {
    label: 'same',
    read: () => ({ dirty: false }),
    prepare: () => () => {},
    focus: () => {},
  };
  inputs.register('same', {
    ...boundary,
    read: () => {
      expect(() => inputs.register('same', boundary)).toThrow('InputAdmission');
      return { dirty: false };
    },
  });
  expect(h.handle.requestClose().state).toBe('revoked');
});
it('D04 input detach notification failures do not skip other inputs or disposers', async () => {
  const h = harness();
  buffer(h, 'a');
  buffer(h, 'b');
  const cleanup = vi.fn();
  api(h.handle, 'lifecycle').registerDisposable('still-run', cleanup);
  const stop = h.binding.inputs.subscribe(() => {
    throw new Error('detach notification');
  });
  expect(() => h.handle.revoke('replace')).not.toThrow();
  stop();
  expect(h.binding.inputs.getSnapshot().dirty).toBe(0);
  expect(cleanup).toHaveBeenCalledTimes(1);
  const report = await h.handle.drain({ deadlineMs: 0 });
  expect(report).toMatchObject({
    state: 'incomplete',
    failed: [
      expect.objectContaining({
        resourceId: 'host:teardown',
        reason: expect.stringContaining('Input detach notification failed'),
      }),
    ],
  });
  expect(h.open().requestClose().state).toBe('revoked');
});
it('D04 pending registration detach failure remains an owned failure after revoke returns', async () => {
  const h = harness();
  const inputs = api(h.handle, 'inputs');
  const stop = h.binding.inputs.subscribe(() => {
    if (h.binding.inputs.getSnapshot().dirty) h.handle.revoke('replace');
    else throw new Error('late detach notification');
  });
  expect(() =>
    inputs.register('late', {
      label: 'late',
      read: () => ({ dirty: true }),
      prepare: () => () => {},
      focus: () => {},
    }),
  ).toThrow('late detach notification');
  stop();
  expect(h.binding.inputs.getSnapshot().dirty).toBe(0);
  expect(await h.handle.drain({ deadlineMs: 0 })).toMatchObject({
    state: 'incomplete',
    failed: [
      expect.objectContaining({
        resourceId: expect.stringMatching(/^input-registration:/),
        reason: 'Error: late detach notification',
      }),
    ],
  });
});
it('I08 unregister notification may replace the same id without deleting the new registration', () => {
  const h = harness();
  const inputs = api(h.handle, 'inputs');
  const original = inputs.register('replaceable', {
    label: 'old',
    read: () => ({ dirty: false, canUndo: true }),
    prepare: () => () => {},
    focus: () => {},
  });
  let replacement: ReturnType<typeof inputs.register> | undefined;
  let replacing = false;
  const stop = h.binding.inputs.subscribe(() => {
    if (!replacing) {
      replacing = true;
      replacement = inputs.register('replaceable', {
        label: 'new',
        read: () => ({ dirty: true }),
        prepare: () => () => {},
        focus: () => {},
      });
    }
  });
  original.unregister();
  stop();
  expect(() => replacement!.changed(1)).not.toThrow();
  expect(h.binding.inputs.getSnapshot().dirty).toBe(1);
  original.unregister();
  expect(h.binding.inputs.getSnapshot().dirty).toBe(1);
  h.handle.revoke('replace');
  expect(h.binding.inputs.getSnapshot().dirty).toBe(0);
});
