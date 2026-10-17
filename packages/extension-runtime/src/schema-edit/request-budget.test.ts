import { expect, it } from 'vitest';
import { command } from '@editor-platform/editor-core';
import { granted } from '../draft2/harness';
import { frozen } from '../draft2/primitives';
import { setup } from './fixture';
it.each(['old', 'new'] as const)(
  '%s request-only byte overflow releases retained snapshot, shared key and preparation hold',
  async (front) => {
    const h = setup();
    const initial = h.handle.context.basic.read();
    const empty = { ...initial, content: { ...initial.content, padding: '' } };
    const bytes = new TextEncoder().encode(JSON.stringify(empty)).length;
    // The complete read snapshot fits exactly; the request adds operationId/capture hash overhead.
    const padding = 'x'.repeat(65536 - bytes);
    h.session.execute(command('fixture', 'fixture', (v) => ({ ...v, padding })));
    const snapshot = h.handle.context.basic.read();
    expect(() => frozen(snapshot)).not.toThrow();
    expect(new TextEncoder().encode(JSON.stringify(snapshot))).toHaveLength(65536);
    const save = granted(
      front === 'old' ? h.old.context.addons.save : h.handle.context.addons.save,
    );
    await expect(save.save()).rejects.toThrow('DataLimit');
    expect(h.storage.requests).toHaveLength(0);
    expect(h.storage.holds).toBe(0);
    // A second front door must be able to save after replacing the deliberately large fixture.
    h.session.execute(command('small', 'small', () => ({ ...initial.content })));
    const next = granted(
      front === 'old' ? h.handle.context.addons.save : h.old.context.addons.save,
    ).save();
    const request = await h.storage.nextRequest();
    h.storage.noWrite(request.operationId);
    await expect(next).resolves.toMatchObject({ state: 'aborted-before-write' });
    h.handle.revoke('host-close');
    h.old.revoke('host-close');
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(await h.handle.drain({ deadlineMs: 0 })).toMatchObject({
      state: 'drained',
      pending: [],
      failed: [],
    });
    expect(await h.old.drain({ deadlineMs: 0 })).toMatchObject({
      state: 'drained',
      pending: [],
      failed: [],
    });
  },
);
it.each(['old', 'new'] as const)(
  '%s repeat oversized save is rejected by budget, not leaked lock, and revoke drains',
  async (front) => {
    const h = setup(),
      initial = h.handle.context.basic.read();
    const empty = { ...initial, content: { ...initial.content, padding: '' } };
    const padding = 'x'.repeat(65536 - new TextEncoder().encode(JSON.stringify(empty)).length);
    h.session.execute(command('fixture', 'fixture', (v) => ({ ...v, padding })));
    const first = granted(
      front === 'old' ? h.old.context.addons.save : h.handle.context.addons.save,
    );
    const second = granted(
      front === 'old' ? h.handle.context.addons.save : h.old.context.addons.save,
    );
    await expect(first.save()).rejects.toThrow('DataLimit');
    await expect.soft(second.save()).rejects.toThrow('DataLimit');
    h.handle.revoke('host-close');
    h.old.revoke('host-close');
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect
      .soft(await h.handle.drain({ deadlineMs: 0 }))
      .toMatchObject({ state: 'drained', pending: [] });
    expect
      .soft(await h.old.drain({ deadlineMs: 0 }))
      .toMatchObject({ state: 'drained', pending: [] });
  },
);
