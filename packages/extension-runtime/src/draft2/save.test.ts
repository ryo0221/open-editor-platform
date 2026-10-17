import { it, expect } from 'vitest';
import { api, harness, admitted, setValue, turns } from './harness';
import { deferred, FakeStorage, referenceBinding } from './reference';
import type { WriteEvidence } from '../draft2';

it('S01 already aborted/permission/input refusal admits no job or write', async () => {
  const h = harness();
  const caller = new AbortController();
  caller.abort();
  expect(() => api(h.handle, 'save').save(caller.signal)).toThrow('Aborted');
  expect(h.registry.saves.observations()).toHaveLength(0);
  h.binding.setGrants(['artifact:read', 'artifact:edit']);
  await expect(api(h.handle, 'save').save()).rejects.toThrow('ScopeRevoked');
  expect(h.storage.requests).toHaveLength(0);
});
it('S02 captured cancel before dispatch releases holds with no-write proof', async () => {
  const h = harness();
  const gate = deferred<void>();
  h.storage.beforeDispatch = () => gate.promise;
  const caller = new AbortController();
  const result = api(h.handle, 'save').save(caller.signal);
  await admitted(h);
  caller.abort();
  await expect(result).resolves.toMatchObject({
    state: 'aborted-before-write',
    proof: 'not-dispatched',
  });
  expect(h.storage.holds).toBe(0);
  gate.resolve();
  await turns();
  expect(h.storage.requests).toHaveLength(0);
});
it('S03/S13 captured revoke prevents dispatch; consumer receives no outcome', async () => {
  const h = harness();
  const gate = deferred<void>();
  h.storage.beforeDispatch = () => gate.promise;
  const result = api(h.handle, 'save')
    .save()
    .catch((error) => error);
  await admitted(h);
  h.binding.setGrants(['artifact:read', 'artifact:edit']);
  expect((await result).code).toBe('ScopeRevoked');
  expect(h.registry.saves.observations()[0].outcome).toMatchObject({
    state: 'aborted-before-write',
    proof: 'not-dispatched',
  });
  gate.resolve();
  await turns();
  expect(h.storage.requests).toHaveLength(0);
});
it('S04 conclusive no-write fences late writes', async () => {
  const h = harness();
  const result = api(h.handle, 'save').save();
  const id = await admitted(h);
  h.storage.noWrite(id);
  await expect(result).resolves.toMatchObject({
    state: 'aborted-before-write',
    proof: 'adapter-no-write-guarantee',
  });
  expect(() => h.storage.commit(id)).toThrow('Fenced');
  expect(h.storage.holds).toBe(0);
});
it.each(['abort-error', 'transport', 'unknown', 'deadline'] as const)(
  'S05/S08 %s after dispatch is indeterminate and retains claim',
  async (reason) => {
    const h = harness();
    const result = api(h.handle, 'save').save();
    const id = await admitted(h);
    if (reason === 'deadline') h.clock.advanceTo(100);
    else if (reason === 'unknown') h.storage.ack(id, { state: 'unknown' });
    else
      h.storage.fail(
        id,
        reason === 'abort-error'
          ? new DOMException('aborted', 'AbortError')
          : new Error('partial transport'),
      );
    await expect(result).resolves.toMatchObject({ state: 'indeterminate' });
    await expect(api(h.handle, 'save').save()).rejects.toThrow('SaveBusy');
    expect(h.storage.holds).toBe(1);
    expect(h.storage.requests).toHaveLength(1);
  },
);
it.each([true, false])('S06 committed ack preserved with cancel first=%s', async (cancelFirst) => {
  const h = harness();
  const caller = new AbortController();
  const result = api(h.handle, 'save').save(caller.signal);
  const id = await admitted(h);
  h.storage.commit(id, false);
  if (cancelFirst) caller.abort();
  h.storage.ack(id, h.storage.evidence(id));
  if (!cancelFirst) {
    await turns();
    caller.abort();
  }
  await expect(result).resolves.toMatchObject({ state: 'committed', operationId: id });
  expect(h.storage.writes).toHaveLength(1);
  expect(h.storage.saved).toHaveLength(1);
});
it('S07 revoke A/open B before late ack keeps true A outcome and denies delivery', async () => {
  const h = harness();
  const result = api(h.handle, 'save')
    .save()
    .catch((error) => error);
  const id = await admitted(h);
  h.storage.commit(id, false);
  h.handle.revoke('replace');
  const b = h.open();
  api(b, 'edit').execute(setValue(2));
  h.storage.ack(id, h.storage.evidence(id));
  expect((await result).code).toBe('ScopeRevoked');
  await turns();
  expect(h.registry.saves.observations()[0].outcome).toMatchObject({
    state: 'committed',
    capture: { scope: h.handle.scope },
  });
  expect(h.storage.saved).toHaveLength(0);
  expect(b.context.basic.read().content.value).toBe(2);
});
it.each(['operationId', 'hash', 'revision', 'scope', 'receipt'] as const)(
  'S09 invalid %s never clears claim or marks saved',
  async (field) => {
    const h = harness();
    const result = api(h.handle, 'save').save();
    const id = await admitted(h);
    const evidence = h.storage.evidence(id) as Extract<WriteEvidence, { state: 'committed' }>;
    if (field === 'operationId') evidence.operationId = 'wrong';
    if (field === 'hash') evidence.capture = { ...evidence.capture, contentHash: 'wrong' };
    if (field === 'revision')
      evidence.capture = {
        ...evidence.capture,
        revision: { ...evidence.capture.revision, sequence: 99 },
      };
    if (field === 'scope')
      evidence.capture = {
        ...evidence.capture,
        scope: { ...evidence.capture.scope, generation: 'wrong' },
      };
    if (field === 'receipt') evidence.adapterReceiptId = '';
    h.storage.ack(id, evidence);
    await expect(result).resolves.toMatchObject({
      state: 'indeterminate',
      reason: 'invalid-receipt',
    });
    expect(h.storage.holds).toBe(1);
    expect(h.storage.saved).toHaveLength(0);
  },
);
it('S10 exact captured r1 ack never marks newer r2 saved or changes Undo', async () => {
  const h = harness();
  api(h.handle, 'edit').execute(setValue(1));
  const result = api(h.handle, 'save').save();
  const id = await admitted(h);
  const captured = h.storage.requests[0].capture;
  api(h.handle, 'edit').execute(setValue(2));
  h.storage.commit(id);
  await expect(result).resolves.toMatchObject({ state: 'committed', capture: captured });
  expect(h.storage.writes[0].content).toEqual({ value: 1 });
  expect(h.storage.saved).toHaveLength(0);
  api(h.handle, 'edit').undo();
  expect(h.handle.context.basic.read().content.value).toBe(1);
});
it('S11 unresolved A blocks reopened B but permits independent artifact C', async () => {
  const h = harness();
  const result = api(h.handle, 'save').save();
  await admitted(h);
  h.clock.advanceTo(100);
  await result;
  h.handle.revoke('replace');
  const b = h.open();
  await expect(api(b, 'save').save()).rejects.toThrow('SaveBusy');
  const c = referenceBinding({ value: 3 }, 'c');
  const storage = new FakeStorage<{ value: number }>('c');
  c.storage = storage;
  const opened = h.installed.open(c);
  if (opened.state !== 'opened') throw new Error();
  const save = api(opened.handle, 'save').save();
  if (!storage.requests.length) await storage.nextRequest();
  storage.commit(storage.requests[0].operationId);
  await expect(save).resolves.toMatchObject({
    state: 'committed',
    capture: { scope: { artifactId: 'c' } },
  });
});
it.each(['committed', 'no-write'] as const)(
  'S12 reconcile %s preserves old settled Promise and releases claim',
  async (state) => {
    const h = harness();
    const result = api(h.handle, 'save').save();
    const id = await admitted(h);
    h.clock.advanceTo(100);
    const first = await result;
    expect(first.state).toBe('indeterminate');
    const evidence: WriteEvidence =
      state === 'committed'
        ? h.storage.evidence(id)
        : {
            state: 'no-write',
            operationId: id,
            capture: h.storage.requests[0].capture,
            guarantee: 'never-writes',
          };
    h.registry.saves.reconcile(id, evidence);
    expect(h.registry.saves.observations()[0].outcome!.state).toBe(
      state === 'committed' ? 'committed' : 'aborted-before-write',
    );
    expect((await result).state).toBe('indeterminate');
    expect(h.storage.holds).toBe(0);
  },
);
it('S14 unresolved captured dependency remains owned after revoke and expired drain', async () => {
  const h = harness();
  const result = api(h.handle, 'save')
    .save()
    .catch((error) => error);
  await admitted(h);
  h.handle.revoke('host-close');
  await result;
  h.clock.advanceTo(100);
  expect(await h.handle.drain({ deadlineMs: 100 })).toMatchObject({
    state: 'incomplete',
    pending: [expect.stringMatching(/^save:/)],
  });
  expect(h.storage.holds).toBe(1);
});
it('S14 hash-preparation capture hold also remains visible until asynchronous work settles', async () => {
  const h = harness();
  const saving = api(h.handle, 'save')
    .save()
    .catch((error) => error);
  h.handle.revoke('host-close');
  const before = await h.handle.drain({ deadlineMs: 0 });
  expect(before).toMatchObject({
    state: 'incomplete',
    pending: [expect.stringMatching(/^save-preparation:/)],
  });
  expect((await saving).code).toBe('ScopeRevoked');
  expect((await h.handle.drain({ deadlineMs: 0 })).state).toBe('drained');
  expect(h.storage.requests).toHaveLength(0);
  expect(h.storage.holds).toBe(0);
});
it.each(['indeterminate', 'dispatched'] as const)(
  'S07/S12 logical revoke suppresses saved marker during unsubscribe reconciliation (%s)',
  async (state) => {
    const h = harness();
    let operationId = '';
    let unsubscribeCalls = 0;
    const opened = h.installed.open({
      ...h.binding,
      subscribePermissions: () => () => {
        unsubscribeCalls++;
        // Revoke has closed the logical gate, but has not fired AbortSignal yet.
        expect(api(handle, 'lifecycle').signal.aborted).toBe(false);
        expect(() => handle.context.basic.read()).toThrow('ScopeRevoked');
        h.registry.saves.reconcile(operationId, h.storage.evidence(operationId));
      },
    });
    if (opened.state !== 'opened') throw new Error(opened.code);
    const handle = opened.handle;
    const consumer = api(handle, 'save')
      .save()
      .catch((error) => error);
    operationId = await admitted(h);
    h.storage.commit(operationId, false);
    if (state === 'indeterminate') {
      h.clock.advanceTo(100);
      expect(await consumer).toMatchObject({ state: 'indeterminate', reason: 'deadline' });
    }
    const savedBefore = [...h.storage.saved];
    handle.revoke('host-close');
    await turns();
    expect(h.registry.saves.observations()[0].outcome).toMatchObject({
      state: 'committed',
      operationId,
      capture: { scope: handle.scope },
    });
    expect(h.storage.saved).toEqual(savedBefore);
    expect(await consumer).toMatchObject(
      state === 'indeterminate'
        ? { state: 'indeterminate', reason: 'deadline' }
        : { code: 'ScopeRevoked' },
    );
    expect(h.storage.holds).toBe(0);
    expect(h.storage.writes).toHaveLength(1);
    expect((await handle.drain({ deadlineMs: h.clock.now() })).state).toBe('drained');
    handle.revoke('host-close');
    expect(unsubscribeCalls).toBe(1);
  },
);

// The permission callback is a synchronous Host reentry boundary even after receipt delivery.
it.each([false, true])(
  'keeps committed receipt but skips revoked saved marker (revoke=%s)',
  async (revokeDuringPermission) => {
    const h = harness();
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
    const result = api(opened.handle, 'save')
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
    expect(h.registry.saves.observations().at(-1)?.outcome).toMatchObject({
      state: 'committed',
      operationId: request.operationId,
      capture: request.capture,
    });
  },
);

it.each(['normal', 'caller-abort', 'revoke', 'uninstall'] as const)(
  'fences handoff after synchronous permission callback %s',
  async (mode) => {
    const h = harness();
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
          else if (mode === 'uninstall') h.registry.uninstall(h.definition.manifest.id);
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
    const pending = api(opened.handle, 'save')
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
    const outcome = h.registry.saves.observations().at(-1)?.outcome;
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
    const h = harness();
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
          else if (mode === 'uninstall') h.registry.uninstall(h.definition.manifest.id);
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
    const pending = api(opened.handle, 'save')
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
    expect(h.registry.saves.observations().at(-1)?.outcome).toMatchObject({
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
