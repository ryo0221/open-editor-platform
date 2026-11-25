import { describe, expect, it, vi } from 'vitest';
import {
  Authority,
  saveConfirmedVersion,
  initial,
  localAdapter,
  type Principal,
  type Operation,
} from '@editor-platform/collaboration-core';
import { createDeck, insertObject } from '@editor-platform/slide/model';
import { SharedEditorSession, type EditorHostAdapter } from './editor-session';
import { slideEditorCodec, prepareEditorCommand } from './editor-transactions';
import { editorAssetCodec, EditorAssetCache } from './editor-assets';
import { command } from '@editor-platform/editor-core';
const proposalHost = {
  actorId: 'host',
  clientId: 'host',
  sessionId: 'host',
  writable: true,
  scopes: ['*'],
};
const principal: Principal = {
  actorId: 'A',
  clientId: 'A',
  sessionId: 'A',
  writable: true,
  scopes: ['*'],
};
const image = 'data:image/png;base64,aGVsbG8=';
function fixture() {
  const d = createDeck(),
    cache = new EditorAssetCache();
  const codec = editorAssetCodec(slideEditorCodec),
    authority = new Authority(
      editorAssetCodec(slideEditorCodec, cache, true),
      initial('a', codec, d),
    );
  const access = { ...principal };
  const base = localAdapter(authority, access);
  const adapter = {
    ...base,
    versions: async () => [],
    undo: async (id: string, redo?: boolean) => authority.undo(access, id, redo),
    registerAsset: async (ref, data) => cache.register(ref, data),
    save: async (reason) => saveConfirmedVersion(authority, principal.actorId, reason),
    restore: async () => {
      throw new Error('No archive in this fixture');
    },
    registerProposal: async (proposal) =>
      authority.register({ ...proposalHost, actorId: proposal.sourceActorId }, proposal),
    previewProposal: async (id) => authority.preview(access, id),
    applyProposal: async (id, token) => authority.applyProposal(access, id, token),
    cancelProposal: async (id, reject) => authority.cancelProposal(proposalHost, id, reject),
  } as EditorHostAdapter<typeof d>;
  return { d, codec, authority, adapter, base };
}

it.each(['proposal', 'undo', 'restore'] as const)(
  'awaits the accepted %s revision when an older background poll is still in flight',
  async (kind) => {
    const { d, codec, authority, adapter } = fixture();
    // HTTP Hosts receive changes by polling, not the local adapter's push callback.
    adapter.subscribe = () => () => {};
    const session = new SharedEditorSession(codec, adapter);
    await session.open();
    session.execute(insertObject(d.slides[0].id, 'shape'));
    await session.flush();
    let committed!: () => void;
    const accepted = new Promise<void>((resolve) => {
      committed = resolve;
    });
    let write: () => Promise<unknown>;
    if (kind === 'proposal') {
      const op = prepareEditorCommand(
        codec,
        session.confirmed,
        principal,
        insertObject(d.slides[0].id, 'text', { text: '追加する内容' }),
      )!;
      await adapter.registerProposal({
        schema: 1,
        id: 'p',
        artifactId: 'a',
        sourceActorId: 'A',
        baseRevision: session.confirmed.revision,
        summary: 'Insert text',
        actions: op.actions,
        reads: op.conditions,
        writes: op.conditions,
        external: [],
      });
      const preview = await adapter.previewProposal('p');
      const apply = adapter.applyProposal;
      adapter.applyProposal = async (id, token) => {
        const receipt = await apply(id, token);
        committed();
        return receipt;
      };
      write = () => session.applyProposal('p', preview.token);
    } else if (kind === 'undo') {
      const undo = adapter.undo;
      adapter.undo = async (id, redo) => {
        const receipt = await undo(id, redo);
        committed();
        return receipt;
      };
      write = () => session.history('undo');
    } else {
      adapter.restore = async (_version, revision) => {
        const receipt = authority.restore(principal, d, revision);
        committed();
        return receipt;
      };
      write = () => session.restore('original-version');
    }
    let reached!: () => void, release!: () => void;
    const reading = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const changes = adapter.changes;
    let first = true;
    adapter.changes = async (revision) => {
      const update = await changes(revision);
      if (first) {
        first = false;
        reached();
        await held;
      }
      return update;
    };
    const oldPoll = session.sync();
    await reading;
    const writing = write();
    await accepted;
    expect(authority.snapshot().revision).toBe(2);
    release();
    await Promise.all([oldPoll, writing]);
    expect(session.confirmed.revision).toBe(2);
    expect(session.content).toEqual(authority.snapshot().content);
    expect(session.content.slides[0].objects).toHaveLength(kind === 'proposal' ? 2 : 0);
    session.close();
  },
);
describe('normal session recovery and capability boundaries', () => {
  it('retains failed asset input across checkpoint, retries one ID/hash operation, then undoes', async () => {
    const { d, codec, authority, adapter } = fixture(),
      session = new SharedEditorSession(codec, adapter);
    await session.open();
    const register = adapter.registerAsset!;
    adapter.registerAsset = async () => {
      throw new Error('asset-unavailable');
    };
    session.execute(insertObject(d.slides[0].id, 'image', { src: image }));
    await session.flush();
    expect(session.pendingCount).toBe(1);
    expect(authority.snapshot().revision).toBe(0);
    const checkpoint = session.checkpoint();
    expect(JSON.stringify(checkpoint.queue[0].op)).not.toContain('base64');
    const restored = new SharedEditorSession(editorAssetCodec(slideEditorCodec), adapter);
    restored.resume(checkpoint);
    adapter.registerAsset = register;
    await restored.open();
    await restored.flush();
    expect(restored.pendingCount).toBe(0);
    expect(authority.snapshot().content.slides[0].objects[0].src).toBe(image);
    await restored.history('undo');
    expect(authority.snapshot().content.slides[0].objects).toHaveLength(0);
    restored.close();
  });
  it('cancelling an unsent edit while registration is awaiting never submits it afterwards', async () => {
    const { d, codec, authority, adapter } = fixture(),
      session = new SharedEditorSession(codec, adapter);
    await session.open();
    let release!: () => void, reached!: () => void;
    const registering = new Promise<void>((resolve) => {
      reached = resolve;
    });
    adapter.registerAsset = async () => {
      reached();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    session.execute(insertObject(d.slides[0].id, 'image', { src: image }));
    await registering;
    session.discardUnsubmitted();
    release();
    await session.flush();
    expect(session.pendingCount).toBe(0);
    expect(authority.snapshot().revision).toBe(0);
    session.close();
  });
  it('undo retries return the same receipt, while expired grants cannot start a new commit', async () => {
    const { d, codec, authority, adapter, base } = fixture(),
      session = new SharedEditorSession(codec, adapter);
    await session.open();
    const op = session.execute(insertObject(d.slides[0].id, 'shape'))!;
    await session.flush();
    const undo = authority.undo(principal, op.operationId);
    expect(authority.undo(principal, op.operationId)).toEqual(undo);
    expect(authority.snapshot().revision).toBe(2);
    base.setPermissions({ writable: true, scopes: ['*'], expiresAt: Date.now() - 1 });
    const stale: Operation = prepareEditorCommand(
      codec,
      authority.snapshot(),
      principal,
      insertObject(d.slides[0].id, 'shape'),
    )!;
    expect(await base.submit(stale)).toMatchObject({ status: 'rejected', code: 'unauthorized' });
    expect(authority.snapshot().revision).toBe(2);
    session.close();
  });
  it('unknown command fields fail explicitly instead of silently dropping changes', () => {
    const { d, codec } = fixture();
    expect(() =>
      prepareEditorCommand(
        codec,
        initial('a', codec, d),
        principal,
        command('future.feature', 'Future feature', (value) => ({ ...value, futureField: true })),
      ),
    ).toThrowError(expect.objectContaining({ code: 'unsupported-operation' }));
  });
});

it('suspends a pending Host session without a later submit or notification, and resumes exactly once', async () => {
  const { d, codec, authority, adapter } = fixture();
  const session = new SharedEditorSession(codec, adapter);
  await session.open();
  let reached!: () => void, release!: () => void;
  const submitting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const submit = adapter.submit;
  adapter.submit = async (op) => {
    reached();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return submit(op);
  };
  session.execute(insertObject(d.slides[0].id, 'shape'));
  await submitting;
  session.execute(insertObject(d.slides[0].id, 'text', { text: '未送信の日本語' }));
  let checkpoint!: ReturnType<typeof session.checkpoint>;
  session.suspend((value) => {
    checkpoint = JSON.parse(JSON.stringify(value));
  });
  let notifications = 0;
  session.onChange = () => {
    notifications++;
  };
  release();
  await session.flush();
  expect(authority.snapshot().revision).toBe(1);
  expect(notifications).toBe(0);
  expect(session.client.status).toBe('closed');
  expect(() => session.execute(insertObject(d.slides[0].id, 'shape'))).toThrow('closed');
  const replacement = { ...adapter, ...localAdapter(authority, { ...principal }) };
  const resumed = new SharedEditorSession(codec, replacement);
  resumed.resume(checkpoint);
  await resumed.open();
  await resumed.flush();
  expect(authority.snapshot().revision).toBe(2);
  expect(resumed.content.slides[0].objects).toHaveLength(2);
  expect(resumed.content.slides[0].objects[1].text).toBe('未送信の日本語');
  resumed.close();
});

it('retains queued Undo/Redo targets on suspension, including a late accepted receipt', async () => {
  const { d, codec, authority, adapter } = fixture();
  const session = new SharedEditorSession(codec, adapter);
  await session.open();
  for (let i = 0; i < 2; i++) {
    session.execute(insertObject(d.slides[0].id, 'shape'));
    await session.flush();
  }
  let reached!: () => void, release!: () => void;
  const awaiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const undo = adapter.undo;
  adapter.undo = async (id, redo) => {
    const receipt = await undo(id, redo);
    reached();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return receipt;
  };
  const first = session.history('undo'),
    second = session.history('undo');
  await awaiting;
  let checkpoint!: ReturnType<typeof session.checkpoint>;
  session.suspend((value) => {
    checkpoint = JSON.parse(JSON.stringify(value));
  });
  release();
  await Promise.all([first, second]);
  expect(session.client.status).toBe('closed');
  expect(authority.snapshot().content.slides[0].objects).toHaveLength(1);
  const resumed = new SharedEditorSession(codec, {
    ...adapter,
    ...localAdapter(authority, { ...principal }),
    undo,
  });
  resumed.resume(checkpoint);
  await resumed.open();
  expect(resumed.content.slides[0].objects).toHaveLength(0);
  expect(authority.snapshot().revision).toBe(4);
  await Promise.all([resumed.history('redo'), resumed.history('redo')]);
  expect(resumed.content.slides[0].objects).toHaveLength(2);
  resumed.close();
});

it('does not detach when Host checkpoint persistence fails', async () => {
  const { codec, adapter } = fixture(),
    session = new SharedEditorSession(codec, adapter);
  await session.open();
  expect(() =>
    session.suspend(() => {
      throw new Error('Storage quota');
    }),
  ).toThrow('Storage quota');
  expect(session.client.status).toBe('online');
  session.close();
});

it('captures a frozen recovery value without freezing live metadata or changing mutable checkpoints', async () => {
  const { d, codec, adapter } = fixture();
  const session = new SharedEditorSession(codec, adapter);
  await session.open();
  session.execute(insertObject(d.slides[0].id, 'shape'));
  await session.flush();
  const captured = session.captureCheckpoint();
  const expected = session.checkpoint();
  expect(captured).toEqual(expected);
  expect(captured.client.confirmed.content).toBe(session.confirmed.content);
  expect(Object.isFrozen(session.confirmed)).toBe(false);
  expect(Object.isFrozen(adapter.identity)).toBe(false);
  expect(() => captured.undoIds.push('foreign-operation')).toThrow();
  expect(() => {
    captured.client.identity.actorId = 'foreign-actor';
  }).toThrow();
  const mutable = session.checkpoint();
  mutable.client.confirmed.content.slides[0].objects[0].text = 'Caller-owned';
  session.execute(insertObject(d.slides[0].id, 'shape'));
  await session.flush();
  await session.history('undo');
  expect(captured).toEqual(expected);
  expect(session.confirmed.content.slides[0].objects[0].text).toBe('');
  session.close();
});

it('retains an immutable pending capture through later input, late receipts and idempotent resume', async () => {
  const { d, codec, authority, adapter } = fixture();
  const session = new SharedEditorSession(codec, adapter);
  await session.open();
  let entered!: () => void, release!: () => void;
  const submitting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const submit = adapter.submit;
  adapter.submit = async (op) => {
    entered();
    await held;
    return submit(op);
  };
  session.execute(insertObject(d.slides[0].id, 'shape'));
  await submitting;
  const captured = session.captureCheckpoint();
  const expected = structuredClone(captured);
  expect(captured.queue).toHaveLength(1);
  expect(captured.client.confirmed.revision).toBe(0);
  session.execute(insertObject(d.slides[0].id, 'text', { text: 'Later input survives' }));
  release();
  await session.flush();
  expect(captured).toEqual(expected);
  session.close();
  const resumed = new SharedEditorSession(codec, {
    ...adapter,
    ...localAdapter(authority, { ...principal }),
  });
  resumed.resume(captured);
  await resumed.open();
  await resumed.flush();
  expect(authority.snapshot().revision).toBe(2);
  expect(resumed.content.slides[0].objects.map((object) => object.text)).toEqual([
    '',
    'Later input survives',
  ]);
  resumed.close();
});

it('isolates a shallow-frozen Host tree and pending text when capturing recovery', async () => {
  const { d, codec, adapter } = fixture();
  const session = new SharedEditorSession(codec, adapter);
  await session.open();
  session.execute(insertObject(d.slides[0].id, 'text', { text: 'Original' }));
  await session.flush();
  const engine = session.text(session.content.slides[0].objects[0].id);
  engine.dispatch(engine.state.tr.insertText('Pending ', 1));
  // Public metadata is not proof that a caller-provided content tree is deeply frozen.
  const supplied = Object.freeze(structuredClone(session.confirmed.content));
  session.client.confirmed.content = supplied;
  const captured = session.captureCheckpoint();
  const expected = structuredClone(captured);
  expect(captured.text[0].steps).not.toHaveLength(0);
  expect(captured.client.confirmed.content).not.toBe(supplied);
  supplied.slides[0].objects[0].text = 'External mutation';
  engine.dispatch(engine.state.tr.insertText('Newer ', 1));
  expect(captured).toEqual(expected);
  expect(Object.isFrozen(supplied.slides[0])).toBe(false);
  session.suspend(() => {});
});

it('advances the recovery revision for pending input and receipts, while idle polling is stable', async () => {
  const { d, codec, adapter } = fixture(),
    session = new SharedEditorSession(codec, adapter);
  await session.open();
  const idle = session.recoveryRevision;
  await session.sync();
  await session.sync();
  expect(session.recoveryRevision).toBe(idle);
  session.execute(insertObject(d.slides[0].id, 'text', { text: '編集前' }));
  expect(session.recoveryRevision).toBeGreaterThan(idle);
  await session.flush();
  const confirmed = session.recoveryRevision;
  const text = session.text(session.content.slides[0].objects[0].id);
  text.dispatch(text.state.tr.insertText('未送信', 1));
  expect(session.recoveryRevision).toBeGreaterThan(confirmed);
  const checkpoint = session.checkpoint();
  expect(JSON.parse(session.serializeCheckpoint())).toEqual(JSON.parse(JSON.stringify(checkpoint)));
  checkpoint.client.confirmed.content.slides[0].objects[0].text = '外部変更';
  expect(session.content.slides[0].objects[0].text).not.toContain('外部変更');
  session.suspend(() => {});
});

it('notifies a polling Host when permissions expire without any content update', async () => {
  const { codec, adapter } = fixture();
  let now = 1000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const permissions = await adapter.permissions();
  adapter.permissions = async () => ({ ...permissions, expiresAt: 2000 });
  const session = new SharedEditorSession(codec, adapter);
  try {
    await session.open();
    const changed = vi.fn();
    session.onChange = changed;
    await session.sync();
    expect(changed).not.toHaveBeenCalled();
    now = 2000;
    await session.sync();
    expect(changed).toHaveBeenCalled();
    expect(session.readOnly).toBe(true);
    expect(session.status).toBe('Read only');
    changed.mockClear();
    await session.sync();
    expect(changed).not.toHaveBeenCalled();
    const { history: _history, ...legacyCheckpoint } = session.checkpoint();
    // The public resume type also accepts older schema-1 checkpoints.
    const replacement = new SharedEditorSession(codec, adapter);
    replacement.resume(legacyCheckpoint);
    replacement.close();
  } finally {
    session.close();
    clock.mockRestore();
  }
});

describe('successful sync connection recovery', () => {
  it('recovers a failed transport without resending uncertain edits or changing their IDs', async () => {
    const { d, codec, adapter } = fixture();
    const session = new SharedEditorSession(codec, adapter);
    await session.open();
    const submit = vi.spyOn(adapter, 'submit').mockRejectedValue(new Error('Lost transport'));
    session.execute(insertObject(d.slides[0].id, 'shape'));
    await session.flush();
    const retained = session.checkpoint();
    expect(session.client.status).toBe('disconnected');
    await session.sync();
    expect(session.client.status).toBe('online');
    expect(session.checkpoint().queue).toEqual(retained.queue);
    expect(session.checkpoint().client.pending).toEqual(retained.client.pending);
    expect(session.checkpoint().rejected).toEqual(retained.rejected);
    expect(submit).toHaveBeenCalledTimes(1);
    session.suspend(() => {});
  });

  it('retains rejected input and its already-created retry proposal through recovery', async () => {
    const { d, codec, adapter, base, authority } = fixture();
    const session = new SharedEditorSession(codec, adapter);
    await session.open();
    const submit = adapter.submit;
    const submitted = vi.spyOn(adapter, 'submit').mockImplementation(async (op) => {
      base.setPermissions({ writable: false, scopes: ['*'] });
      return submit(op);
    });
    session.execute(insertObject(d.slides[0].id, 'shape'));
    await session.flush();
    expect(session.rejected).toHaveLength(1);
    base.setPermissions({ writable: true, scopes: ['*'] });
    const retry = await session.previewRetained();
    const retained = session.checkpoint().rejected;
    const error = session.error;
    session.client.status = 'disconnected';
    await session.sync();
    expect(session.client.status).toBe('online');
    expect(session.checkpoint().rejected).toEqual(retained);
    expect(session.error).toBe(error);
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(authority.snapshot().revision).toBe(0);
    await session.applyProposal(retry.id, retry.preview.token);
    expect(session.rejected).toHaveLength(0);
    expect(authority.snapshot().content.slides[0].objects).toHaveLength(1);
    expect(authority.snapshot().revision).toBe(1);
    session.close();
  });

  it.each(['close', 'stop', 'new failure'] as const)(
    'does not replace %s arriving after a sync begins',
    async (interruption) => {
      const { codec, adapter } = fixture();
      let status!: Parameters<EditorHostAdapter<unknown>['subscribeStatus']>[0];
      const subscribe = adapter.subscribeStatus;
      adapter.subscribeStatus = (listener) => {
        status = listener;
        return subscribe(listener);
      };
      const session = new SharedEditorSession(codec, adapter);
      await session.open();
      session.client.status = 'disconnected';
      let reached!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const changes = adapter.changes;
      adapter.changes = async (revision) => {
        const result = await changes(revision);
        reached();
        await held;
        return result;
      };
      const sync = session.sync();
      await entered;
      if (interruption === 'close') session.close();
      else if (interruption === 'stop') status({ type: 'connection', state: 'disconnected' });
      else session.client.status = 'disconnected';
      release();
      await sync;
      expect(session.client.status).toBe(interruption === 'close' ? 'closed' : 'disconnected');
      if (interruption === 'stop') {
        await session.sync();
        expect(session.client.status).toBe('disconnected');
      }
      session.close();
    },
  );

  it('rejects a presence update racing expiry, then recovers without widening permission', async () => {
    const { codec, adapter, base, authority } = fixture();
    const session = new SharedEditorSession(codec, adapter);
    await session.open();
    const presence = adapter.presence;
    let expire = true;
    adapter.presence = async (value) => {
      if (expire) {
        expire = false;
        base.setPermissions({ writable: false, scopes: [], expiresAt: Date.now() - 1 });
      }
      return presence(value);
    };
    await expect(session.sync()).rejects.toMatchObject({
      code: 'unauthorized',
      message: 'Session expired',
    });
    // The polling Host records the failed sync, as in shared-host.tsx.
    session.client.status = 'disconnected';
    expect(session.readOnly).toBe(true);
    const checkpoint = session.checkpoint();
    await session.sync();
    expect(session.client.status).toBe('online');
    expect(session.readOnly).toBe(true);
    expect(session.client.permissions).toMatchObject({ writable: false, scopes: [] });
    expect(() => session.execute(insertObject(session.content.slides[0].id, 'shape'))).toThrow(
      'Shared session is read only or expired',
    );
    expect(session.checkpoint().queue).toEqual(checkpoint.queue);
    expect(authority.snapshot().revision).toBe(0);
    expect(session.presences).toEqual([]);
    base.setPermissions({ writable: true, scopes: ['*'], expiresAt: Date.now() + 3600000 });
    await session.sync();
    expect(session.status).toContain('Shared · confirmed');
    expect(session.readOnly).toBe(false);
    session.close();
  });
});
