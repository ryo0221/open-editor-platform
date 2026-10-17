import { expect, it } from 'vitest';
import { command } from '@editor-platform/editor-core';
import { contentHash } from '@editor-platform/artifact-core';
import { granted, turns } from '../draft2/harness';
import { deferred } from '../draft2/primitives';
import { setup, type Native } from './fixture';
it.each(['old', 'new'] as const)(
  'shares SaveBusy across %s to the other front door and exact captured receipt',
  async (first) => {
    const h = setup();
    const a = granted(first === 'old' ? h.old.context.addons.save : h.handle.context.addons.save),
      b = granted(first === 'old' ? h.handle.context.addons.save : h.old.context.addons.save);
    const result = a.save();
    const request = await h.storage.nextRequest();
    await expect(b.save()).rejects.toThrow('SaveBusy');
    expect(request.capture.revision).toEqual(h.session.revision);
    expect(request.capture.contentHash).toBe(await contentHash(h.session.content));
    h.storage.commit(request.operationId);
    await expect(result).resolves.toMatchObject({
      state: 'committed',
      operationId: request.operationId,
      capture: request.capture,
      receipt: { durability: 'adapter-acknowledged' },
    });
    const next = b.save();
    const request2 = await h.storage.nextRequest();
    h.storage.noWrite(request2.operationId);
    await expect(next).resolves.toMatchObject({
      state: 'aborted-before-write',
      proof: 'adapter-no-write-guarantee',
    });
  },
);
it.each(['unknown', 'transport', 'deadline', 'invalid-receipt'] as const)(
  'keeps the shared key locked after %s and revoke until conclusive reconciliation',
  async (reason) => {
    const h = setup();
    const result = granted(h.handle.context.addons.save).save();
    const req = await h.storage.nextRequest();
    if (reason === 'unknown') h.storage.ack(req.operationId, { state: 'unknown' });
    else if (reason === 'transport') h.storage.fail(req.operationId);
    else if (reason === 'deadline') h.clock.advanceTo(100);
    else
      h.storage.ack(req.operationId, {
        ...h.storage.evidence(req.operationId),
        operationId: 'wrong',
      } as never);
    await expect(result).resolves.toMatchObject({
      state: 'indeterminate',
      operationId: req.operationId,
      capture: req.capture,
    });
    h.handle.revoke('replace');
    await expect(granted(h.old.context.addons.save).save()).rejects.toThrow('SaveBusy');
    expect(await h.handle.drain({ deadlineMs: h.clock.now() })).toMatchObject({
      state: 'incomplete',
    });
    const fresh = h.open();
    await expect(granted(fresh.context.addons.save).save()).rejects.toThrow('SaveBusy');
    h.owner.saves.reconcile(req.operationId, {
      state: 'no-write',
      operationId: req.operationId,
      capture: req.capture,
      guarantee: 'never-writes',
    });
    expect(await h.handle.drain({ deadlineMs: h.clock.now() + 1000 })).toMatchObject({
      state: 'drained',
      failed: [],
    });
    const next = granted(fresh.context.addons.save).save(),
      r = await h.storage.nextRequest();
    h.storage.commit(r.operationId);
    await expect(next).resolves.toMatchObject({ state: 'committed' });
  },
);
it('cancel before dispatch has not-dispatched proof and releases shared claim without a write', async () => {
  const gate = deferred<void>();
  const h = setup({
    storageSetup: (s) => {
      s.beforeDispatch = () => gate.promise;
    },
  });
  const caller = new AbortController();
  const admission = h.owner.saves.nextAdmission();
  const result = granted(h.handle.context.addons.save).save(caller.signal);
  await admission;
  caller.abort();
  await expect(result).resolves.toMatchObject({
    state: 'aborted-before-write',
    proof: 'not-dispatched',
  });
  expect(h.storage.requests).toHaveLength(0);
  gate.resolve();
  await turns();
  expect(h.storage.requests).toHaveLength(0);
});
it('late committed receipt after revoke stays recorded but cannot deliver into fresh scope', async () => {
  const h = setup();
  const result = granted(h.handle.context.addons.save)
    .save()
    .catch((error) => error);
  const req = await h.storage.nextRequest();
  h.storage.commit(req.operationId, false);
  h.handle.revoke('replace');
  const fresh = h.open();
  expect(await h.handle.drain({ deadlineMs: 0 })).toMatchObject({ state: 'incomplete' });
  h.storage.ack(req.operationId, h.storage.evidence(req.operationId));
  expect((await result).code).toBe('ScopeRevoked');
  await turns();
  expect(h.owner.saves.observations()[0].outcome).toMatchObject({
    state: 'committed',
    capture: req.capture,
  });
  expect(h.storage.saved).toHaveLength(0);
  expect(fresh.scope.generation).not.toBe(req.capture.scope.generation);
  expect(await h.handle.drain({ deadlineMs: 1000 })).toMatchObject({ state: 'drained' });
});
it('flushes one aggregate Inputs commit before captured native save; invalid preparation dispatches nothing', async () => {
  const h = setup();
  let dirty = true,
    value = 4;
  const group = h.controller.bindInputs({
    label: 'aggregate',
    read: () => ({ dirty, composing: false }),
    focus: () => {},
    prepare: (s) => ({
      baseRevision: s.revision,
      command: command<Native>('input', 'input', (v) => ({ ...v, value })),
    }),
    committed: () => {
      dirty = false;
    },
  });
  group.changed();
  const result = h.controller.save();
  const req = await h.storage.nextRequest();
  expect(req.content.value).toBe(4);
  expect(req.capture.revision.sequence).toBe(1);
  h.storage.commit(req.operationId);
  await expect(result).resolves.toMatchObject({
    state: 'outcome',
    outcome: { state: 'committed' },
  });
  value = -1;
  dirty = true;
  group.changed();
  expect((await h.controller.save()).state).toBe('refused');
  expect(h.storage.requests).toHaveLength(1);
  expect(h.session.content.value).toBe(4);
});

// The permission callback is a synchronous Host reentry boundary even after receipt delivery.
it.each([false, true])(
  'keeps committed receipt but skips revoked saved marker (revoke=%s)',
  async (revokeDuringPermission) => {
    const h = setup();
    let armed = false;
    let revocations = 0;
    const opened = h.installed.open({
      ...h.binding,
      allowed: (grant) => {
        if (armed) {
          armed = false;
          revocations++;
          if (opened.state === 'opened') opened.handle.revoke('host-close');
        }
        return h.binding.allowed(grant);
      },
    });
    if (opened.state !== 'opened') throw Error(opened.code);
    const result = granted(opened.handle.context.addons.save)
      .save()
      .catch((error: Error & { code: string }) => ({ code: error.code }));
    const request = await h.storage.nextRequest();
    armed = revokeDuringPermission;
    h.storage.commit(request.operationId);
    if (revokeDuringPermission) await expect(result).resolves.toEqual({ code: 'ScopeRevoked' });
    else await expect(result).resolves.toMatchObject({ state: 'committed' });
    expect(revocations).toBe(revokeDuringPermission ? 1 : 0);
    expect(h.storage.saved).toHaveLength(revokeDuringPermission ? 0 : 1);
    expect(h.storage.writes).toHaveLength(1);
    expect(h.storage.holds).toBe(0);
    expect(h.owner.saves.observations().at(-1)?.outcome).toMatchObject({
      state: 'committed',
      operationId: request.operationId,
      capture: request.capture,
    });
  },
);

it.each(['normal', 'caller-abort', 'revoke', 'uninstall'] as const)(
  'fences handoff after synchronous permission callback %s',
  async (mode) => {
    const h = setup();
    const entered = deferred<void>(),
      gate = deferred<void>();
    const caller = new AbortController();
    let armed = false,
      callbacks = 0,
      releases = 0,
      disposals = 0;
    const retain = h.storage.retainCapture;
    h.storage.retainCapture = () => {
      const release = retain();
      return () => {
        releases++;
        release();
      };
    };
    h.storage.beforeDispatch = () => {
      entered.resolve();
      return gate.promise;
    };
    const opened = h.installed.open({
      ...h.binding,
      allowed: (grant) => {
        if (armed && grant === 'artifact:save') {
          armed = false;
          callbacks++;
          if (mode === 'caller-abort') caller.abort();
          else if (mode === 'revoke' && opened.state === 'opened')
            opened.handle.revoke('host-close');
          else if (mode === 'uninstall') h.registry.uninstall(h.def.manifest.id);
        }
        return h.binding.allowed(grant);
      },
    });
    if (opened.state !== 'opened') throw Error(opened.code);
    const lifecycle = opened.handle.context.addons.lifecycle;
    if (lifecycle.state !== 'granted') throw Error('Lifecycle missing');
    lifecycle.api.registerDisposable('handoff-test', () => {
      disposals++;
    });
    const pending = granted(opened.handle.context.addons.save)
      .save(caller.signal)
      .catch((error: Error & { code: string }) => ({ code: error.code }));
    await entered.promise;
    expect(h.storage.holds).toBe(1);
    expect(h.storage.requests).toHaveLength(0);
    const request = mode === 'normal' ? h.storage.nextRequest() : undefined;
    armed = true;
    gate.resolve();
    if (request) h.storage.commit((await request).operationId);
    const result = await pending;
    await turns();
    expect(callbacks).toBe(1);
    expect(releases).toBe(1);
    expect(h.storage.holds).toBe(0);
    expect(disposals).toBe(mode === 'revoke' || mode === 'uninstall' ? 1 : 0);
    const outcome = h.owner.saves.observations().at(-1)?.outcome;
    if (mode === 'normal') {
      expect(result).toMatchObject({ state: 'committed' });
      expect(outcome).toMatchObject({ state: 'committed' });
    } else {
      expect(outcome).toMatchObject({ state: 'aborted-before-write', proof: 'not-dispatched' });
      expect(result).toMatchObject(
        mode === 'caller-abort'
          ? { state: 'aborted-before-write', proof: 'not-dispatched' }
          : { code: 'ScopeRevoked' },
      );
    }
    expect(h.storage.requests).toHaveLength(mode === 'normal' ? 1 : 0);
    expect(h.storage.writes).toHaveLength(mode === 'normal' ? 1 : 0);
    expect(h.storage.saved).toHaveLength(mode === 'normal' ? 1 : 0);
  },
);

it.each(['normal', 'caller-abort', 'revoke', 'uninstall'] as const)(
  'fences revoked delivery after legitimate saved marker (%s)',
  async (mode) => {
    const h = setup();
    const caller = new AbortController();
    let armed = false,
      callbacks = 0,
      disposals = 0,
      releases = 0;
    const retain = h.storage.retainCapture;
    h.storage.retainCapture = () => {
      const release = retain();
      return () => {
        releases++;
        release();
      };
    };
    const markSaved = h.storage.markSaved;
    h.storage.markSaved = (capture) => {
      markSaved(capture);
      armed = true;
    };
    const opened = h.installed.open({
      ...h.binding,
      allowed: (grant) => {
        if (armed) {
          armed = false;
          callbacks++;
          if (mode === 'caller-abort') caller.abort();
          else if (mode === 'revoke' && opened.state === 'opened')
            opened.handle.revoke('host-close');
          else if (mode === 'uninstall') h.registry.uninstall(h.def.manifest.id);
        }
        return h.binding.allowed(grant);
      },
    });
    if (opened.state !== 'opened') throw Error(opened.code);
    const lifecycle = opened.handle.context.addons.lifecycle;
    if (lifecycle.state !== 'granted') throw Error('Lifecycle missing');
    lifecycle.api.registerDisposable('delivery-test', () => {
      disposals++;
    });
    const pending = granted(opened.handle.context.addons.save)
      .save(caller.signal)
      .catch((error: Error & { code: string }) => ({ code: error.code }));
    const request = await h.storage.nextRequest();
    h.storage.commit(request.operationId);
    const result = await pending;
    await turns();
    expect(callbacks).toBe(1);
    expect(releases).toBe(1);
    expect(h.storage.holds).toBe(0);
    expect(h.storage.requests).toHaveLength(1);
    expect(h.storage.writes).toHaveLength(1);
    expect(h.storage.saved).toEqual([request.capture]);
    expect(h.owner.saves.observations().at(-1)?.outcome).toMatchObject({
      state: 'committed',
      operationId: request.operationId,
      capture: request.capture,
      receipt: { durability: 'adapter-acknowledged' },
    });
    const revoked = mode === 'revoke' || mode === 'uninstall';
    expect(disposals).toBe(revoked ? 1 : 0);
    expect(result).toMatchObject(
      revoked
        ? { code: 'ScopeRevoked' }
        : {
            state: 'committed',
            operationId: request.operationId,
            capture: request.capture,
          },
    );
  },
);
