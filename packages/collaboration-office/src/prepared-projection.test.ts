import { expect, it } from 'vitest';
import { deepFreeze } from '@editor-platform/artifact-core';
import {
  Authority,
  CollaborationClient,
  initial,
  localAdapter,
  preparedResult,
  type Accepted,
  type DomainCodec,
  type PreparedOperation,
  type Snapshot,
} from '@editor-platform/collaboration-core';
import { setCell, type StructuredData } from '@editor-platform/structured-data';
import { transformElements } from '@editor-platform/design/model';
import {
  dataEditorCodec,
  designEditorCodec,
  prepareEditorCommand,
  prepareEditorProjection,
  SharedEditorSession,
  type EditorHostAdapter,
} from '@editor-platform/collaboration-adapters';
import { dataFixture, designFixture, person } from './fixtures';

async function fixture(immutableContent = true) {
  let applications = 0;
  const codec: DomainCodec<StructuredData> = {
    ...dataEditorCodec,
    applyReadonly(...args) {
      applications++;
      return dataEditorCodec.applyReadonly!(...args);
    },
  };
  const actor = person('A');
  const authority = new Authority(codec, initial('prepared', codec, dataFixture()));
  const adapter = localAdapter(authority, actor);
  const client = new CollaborationClient(codec, adapter, { immutableContent });
  await client.open();
  return { codec, actor, authority, adapter, client, applications: () => applications };
}

it('validates an exactly matching confirmed projection without recopying it and still rejects invalid metadata or a changed validator', async () => {
  const seen: StructuredData[] = [];
  const codec: DomainCodec<StructuredData> = {
    ...dataEditorCodec,
    validate(content): content is StructuredData {
      seen.push(content as StructuredData);
      return dataEditorCodec.validate(content);
    },
  };
  const actor = person('A');
  const authority = new Authority(codec, initial('received', codec, dataFixture()));
  const transport = localAdapter(authority, actor);
  let event!: Accepted<StructuredData>;
  const client = new CollaborationClient(
    codec,
    {
      ...transport,
      subscribe: () =>
        transport.subscribe((value) => {
          event = structuredClone(value);
        }),
    },
    { immutableContent: true },
  );
  await client.open();
  const prepared = prepareEditorProjection(
    codec,
    client.optimistic,
    actor,
    setCell('row1', 'value', 31),
  )!;
  client.enqueuePrepared(prepared);
  const painted = client.optimistic.content;
  expect((await transport.submit(prepared.operation)).status).toBe('accepted');
  seen.length = 0;
  client.receive(event);
  expect(seen[0]).toBe(painted);
  expect(client.confirmed.content).toBe(painted);
  expect(client.confirmed.revision).toBe(event.revision);
  event.snapshot.content.rows[0].values.value = 999;
  expect(client.confirmed.content.rows[0].values.value).toBe(31);
  expect(() => client.install(null as unknown as Snapshot<StructuredData>)).toThrow(
    'Invalid collaboration snapshot',
  );
  expect(() =>
    client.install({
      ...client.confirmed,
      stamps: { invalid: client.confirmed.revision + 1 },
    }),
  ).toThrow('Invalid collaboration snapshot');
  codec.validate = (content): content is StructuredData => content === undefined;
  expect(() => client.install(structuredClone(client.confirmed))).toThrow(
    'Invalid collaboration snapshot',
  );
  codec.validate = dataEditorCodec.validate;
  const changed = structuredClone(client.confirmed);
  changed.revision++;
  changed.content.rows[0].values.value = 52;
  client.install(changed);
  changed.content.rows[0].values.value = 77;
  expect(client.confirmed.content.rows[0].values.value).toBe(52);
  expect(client.confirmed.content).not.toBe(painted);
  client.close();
});

it('reuses a checked first edit without reapplying it and still commits and selectively undoes', async () => {
  const { codec, actor, client, authority, applications } = await fixture();
  const before = structuredClone(client.confirmed);
  const prepared = prepareEditorProjection(
    codec,
    client.optimistic,
    actor,
    setCell('row1', 'value', 31),
  )!;
  expect(applications()).toBe(1);
  const preview = preparedResult(prepared);
  const retained = preparedResult(prepared, { immutableContent: true });
  expect(() => {
    retained.content.rows[0].values.value = 99;
  }).toThrow();
  retained.stamps.test = 999;
  expect(preparedResult(prepared).stamps.test).toBeUndefined();
  preview.content.rows[0].values.value = 999;
  expect(preparedResult(prepared).content.rows[0].values.value).toBe(31);
  client.enqueuePrepared(prepared);
  expect(applications()).toBe(1);
  expect(client.pending[0]).toBe(prepared.operation);
  expect(Object.isFrozen(client.pending[0])).toBe(true);
  expect(client.confirmed).toEqual(before);
  expect(client.optimistic.content.rows.map((r) => r.values.value)).toEqual([31, 20]);
  expect(client.optimistic.content.rows[1]).toBe(client.confirmed.content.rows[1]);
  expect(Object.isFrozen(client.optimistic.content)).toBe(true);
  expect(Object.isFrozen(client.optimistic.stamps)).toBe(false);
  client.enqueuePrepared(prepared);
  expect(client.pending).toHaveLength(1);
  expect((await client.submit(prepared.operation)).status).toBe('accepted');
  expect(authority.undo(actor, prepared.operation.operationId).status).toBe('accepted');
  await client.sync();
  expect(client.confirmed.content).toEqual(before.content);
  client.close();
});

it('replays an existing queue instead of overwriting a preceding optimistic edit', async () => {
  const { codec, actor, client, applications } = await fixture();
  const first = prepareEditorProjection(
    codec,
    client.optimistic,
    actor,
    setCell('row1', 'value', 31),
  )!;
  const second = prepareEditorProjection(
    codec,
    client.optimistic,
    actor,
    setCell('row2', 'value', 42),
  )!;
  client.enqueuePrepared(first);
  const count = applications();
  client.enqueuePrepared(second);
  expect(applications()).toBeGreaterThan(count);
  expect(client.optimistic.content.rows.map((r) => r.values.value)).toEqual([31, 42]);
  await client.submit(first.operation);
  await client.submit(second.operation);
  expect(client.confirmed.content.rows.map((r) => r.values.value)).toEqual([31, 42]);
  client.close();
});

it('rechecks newer authority content and retains the original stale-precondition rejection', async () => {
  const { codec, actor, client, authority, applications } = await fixture();
  const prepared = prepareEditorProjection(
    codec,
    client.optimistic,
    actor,
    setCell('row1', 'value', 31),
  )!;
  const peer = person('B');
  const remote = prepareEditorCommand(
    codec,
    authority.snapshot(),
    peer,
    setCell('row1', 'value', 52),
  )!;
  expect(authority.submit(peer, remote).status).toBe('accepted');
  const count = applications();
  client.enqueuePrepared(prepared);
  expect(applications()).toBeGreaterThan(count);
  expect((await client.submit(prepared.operation)).status).toBe('rejected');
  expect(client.receipts.get(prepared.operation.operationId)).toMatchObject({
    code: 'stale-precondition',
  });
  expect(client.confirmed.content.rows[0].values.value).toBe(52);
  client.close();
});

it('does not reuse a projection across changed snapshot metadata or codec methods', async () => {
  const { codec, actor, client, applications } = await fixture();
  const prepared = prepareEditorProjection(
    codec,
    client.optimistic,
    actor,
    setCell('row1', 'value', 31),
  )!;
  client.confirmed.stamps['thread:metadata'] = 7;
  client.confirmed.engineVersion = 9;
  client.enqueuePrepared(prepared);
  expect(applications()).toBe(2);
  expect(client.optimistic.stamps['thread:metadata']).toBe(7);
  expect(client.optimistic.engineVersion).toBe(9);
  client.discardUnsubmitted(prepared.operation.operationId);
  const next = prepareEditorProjection(
    codec,
    client.optimistic,
    actor,
    setCell('row2', 'value', 42),
  )!;
  codec.validate = (content): content is StructuredData => content === undefined;
  client.enqueuePrepared(next);
  expect(client.held.get(next.operation.operationId)?.status).toBe('rejected');
  expect(client.optimistic.content.rows[1].values.value).toBe(20);
  client.close();
});

it.each([false, true])(
  'keeps mutable and shallow-frozen caller input isolated (shallow freeze: %s)',
  async (shallow) => {
    const { codec, actor, client } = await fixture(false);
    const source = structuredClone(client.confirmed);
    if (shallow) Object.freeze(source.content);
    const prepared = prepareEditorProjection(codec, source, actor, setCell('row1', 'value', 31))!;
    expect(Object.isFrozen(source.content.rows[1])).toBe(false);
    source.content.rows[1].values.value = 99;
    client.confirmed.content.rows[1].values.value = 77;
    client.enqueuePrepared(prepared);
    expect(client.optimistic.content.rows.map((r) => r.values.value)).toEqual([31, 77]);
    client.optimistic.content.rows[1].values.value = 88;
    expect(client.confirmed.content.rows[1].values.value).toBe(77);
    expect(Object.isFrozen(actor.scopes)).toBe(false);
    expect(() => {
      prepared.operation.actions[0].payload.changes = [];
    }).toThrow();
    expect(() =>
      client.enqueuePrepared({
        operation: prepared.operation,
      } as PreparedOperation<StructuredData>),
    ).toThrow('Unknown prepared operation');
    client.close();
  },
);

it('keeps authority permission enforcement after successful local preparation', async () => {
  const { codec, actor, client, adapter } = await fixture();
  const prepared = prepareEditorProjection(
    codec,
    client.optimistic,
    actor,
    setCell('row1', 'value', 31),
  )!;
  adapter.setPermissions({ writable: false, scopes: [] });
  client.enqueuePrepared(prepared);
  expect(await client.submit(prepared.operation)).toMatchObject({
    status: 'rejected',
    code: 'unauthorized',
  });
  expect(client.confirmed.content.rows[0].values.value).toBe(10);
  client.close();
});

it('can queue a prepared operation before opening and evaluates it against the opened snapshot', async () => {
  const actor = person('A');
  const state = deepFreeze(initial('before-open', dataEditorCodec, dataFixture()));
  const authority = new Authority(dataEditorCodec, state);
  const prepared = prepareEditorProjection(
    dataEditorCodec,
    state,
    actor,
    setCell('row1', 'value', 31),
  )!;
  const client = new CollaborationClient(dataEditorCodec, localAdapter(authority, actor), {
    immutableContent: true,
  });
  client.enqueuePrepared(prepared);
  expect(client.pending).toHaveLength(1);
  await client.open();
  expect(client.optimistic.content.rows[0].values.value).toBe(31);
  expect((await client.submit(prepared.operation)).status).toBe('accepted');
  client.close();
});

it('preserves Design geometry dependencies, transaction identity and native results', () => {
  const state = deepFreeze(initial('prepared-design', designEditorCodec, designFixture()));
  const actor = person('A');
  const command = transformElements(['group'], { dx: 12, dy: 3, dw: 0, dh: 0 });
  command.context = { origin: 'proposal', transactionId: 'stable-transaction' };
  const ordinary = prepareEditorCommand(designEditorCodec, state, actor, command)!;
  const prepared = prepareEditorProjection(designEditorCodec, state, actor, command)!;
  expect(prepared.operation.actions).toEqual(ordinary.actions);
  expect(prepared.operation.conditions).toEqual(ordinary.conditions);
  expect(prepared.operation.targets).toEqual(ordinary.targets);
  expect(prepared.operation.origin).toBe('proposal');
  expect(prepared.operation.transactionId).toBe('stable-transaction');
  const authority = new Authority(designEditorCodec, state);
  expect(authority.submit(actor, prepared.operation).status).toBe('accepted');
  expect(authority.snapshot().content).toEqual(command.apply(state.content));
  expect(state.content.elements[1].bounds.x).toBe(10);
});

it('shares owned UI operations but preserves caller copies, sent bytes and older recovery captures during rebasing', async () => {
  const actor = person('A');
  const authority = new Authority(
    dataEditorCodec,
    initial('owned-ui', dataEditorCodec, dataFixture()),
  );
  const transport = localAdapter(authority, actor);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const submitted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const sent: string[] = [];
  const unused = async () => {
    throw new Error('Not used by this operation test');
  };
  const adapter: EditorHostAdapter<StructuredData> = {
    ...transport,
    submit: async (op) => {
      sent.push(JSON.stringify(op));
      if (sent.length === 1) {
        entered();
        await held;
      }
      return transport.submit(op);
    },
    versions: async () => [],
    undo: async (id, redo) => authority.undo(actor, id, redo),
    save: unused,
    restore: unused,
    registerProposal: unused,
    previewProposal: unused,
    applyProposal: unused,
    cancelProposal: unused,
  };
  const session = new SharedEditorSession(dataEditorCodec, adapter);
  await session.open();
  const view = session.executeView(setCell('row1', 'value', 31));
  expect(Object.isFrozen(view)).toBe(true);
  const firstBytes = JSON.stringify(session.client.pending[0]);
  const callerOperation = session.execute(setCell('row1', 'value', 42))!;
  callerOperation.actions[0].payload.changes = [];
  await submitted;
  const captured = session.captureCheckpoint();
  const capturedBytes = JSON.stringify(captured);
  expect(captured.queue[1].op.baseRevision).toBe(0);
  release();
  await session.flush();
  expect(session.content.rows[0].values.value).toBe(42);
  expect(view.rows[0].values.value).toBe(31);
  expect(sent[0]).toBe(firstBytes);
  expect(JSON.parse(sent[1]).baseRevision).toBe(1);
  expect(JSON.stringify(captured)).toBe(capturedBytes);
  const checkpoint = session.checkpoint();
  checkpoint.client.confirmed.content.rows[0].values.value = 999;
  expect(session.content.rows[0].values.value).toBe(42);
  await session.history('undo');
  expect(session.content.rows[0].values.value).toBe(31);
  await session.history('undo');
  expect(session.content.rows[0].values.value).toBe(10);
  session.close();
});
