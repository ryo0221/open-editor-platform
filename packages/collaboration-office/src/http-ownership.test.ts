import { afterEach, expect, it, vi } from 'vitest';
import { deepFreeze, isDeepFrozen, isImmutableJson } from '@editor-platform/artifact-core';
import { Authority, CollaborationClient, initial } from '@editor-platform/collaboration-core';
import { addRow, createData, setCell } from '@editor-platform/structured-data';
import { dataEditorCodec, prepareEditorCommand } from './editor-transactions';
import { HttpEditorAdapter } from './editor-http';

afterEach(() => vi.unstubAllGlobals());
const identity = { actorId: 'A', clientId: 'A', sessionId: 'A' };
const principal = { ...identity, writable: true, scopes: ['*'] };
function fixture() {
  const content = addRow().apply(createData());
  const seed = initial('http-ownership', dataEditorCodec, content);
  const authority = new Authority(dataEditorCodec, seed);
  const field = content.columns[2].id;
  for (const value of [12, 13]) {
    const op = prepareEditorCommand(
      dataEditorCodec,
      authority.snapshot(),
      identity,
      setCell(content.rows[0].id, field, value),
    )!;
    expect(authority.submit(principal, op).status).toBe('accepted');
  }
  return { seed, authority, field };
}

for (const immutable of [false, true])
  it(`HTTP content ownership is explicit before listeners and snapshot fallback (${immutable})`, async () => {
    const { seed, authority, field } = fixture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(input);
        const value = url.pathname.endsWith('/snapshot')
          ? seed
          : url.pathname.endsWith('/changes')
            ? authority.changes(Number(url.searchParams.get('after')))
            : principal;
        return new Response(JSON.stringify(value), {
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    const adapter = new HttpEditorAdapter<typeof seed.content>(
      identity,
      'reference',
      'data',
      'https://example.invalid/api',
      immutable ? { immutableContent: true } : undefined,
    );
    const client = new CollaborationClient(dataEditorCodec, adapter, { immutableContent: true });
    const opened = await adapter.open();
    expect(isDeepFrozen(opened.content)).toBe(immutable);
    expect(isImmutableJson(opened.content)).toBe(immutable);
    expect(Object.isFrozen(opened)).toBe(false);
    expect(Object.isFrozen(opened.stamps)).toBe(false);
    client.install(opened);
    const seen: number[] = [];
    const stop = adapter.subscribe((event) => {
      expect(isDeepFrozen(event.snapshot.content)).toBe(immutable);
      expect(isImmutableJson(event.snapshot.content)).toBe(immutable);
      expect(Object.isFrozen(event)).toBe(false);
      expect(Object.isFrozen(event.snapshot.stamps)).toBe(false);
      seen.push(event.revision);
      client.receive(event);
    });
    const update = await adapter.changes(0);
    expect(seen).toEqual([1, 2]);
    expect(client.confirmed.content.rows[0].values[field]).toBe(13);
    expect(client.confirmed.content === update.events[1].snapshot.content).toBe(immutable);
    if (!immutable) {
      update.events[1].snapshot.content.rows[0].values[field] = 99;
      expect(client.confirmed.content.rows[0].values[field]).toBe(13);
    }
    authority.compact();
    const compacted = await adapter.changes(0);
    expect(compacted.events).toEqual([]);
    expect(isDeepFrozen(compacted.snapshot!.content)).toBe(immutable);
    expect(compacted.snapshot!.content.rows[0].values[field]).toBe(13);
    compacted.snapshot!.artifactId = 'forged-artifact';
    expect(() => client.receive({ ...update.events[1], snapshot: compacted.snapshot! })).toThrow(
      'identity/revision',
    );
    expect(client.confirmed.artifactId).toBe(seed.artifactId);
    stop();
  });

it('buffered frozen event content is shared while envelopes and shallow-frozen input stay isolated', () => {
  const { seed, authority, field } = fixture();
  const [first, second] = authority.changes(0).events;
  const adapter = new HttpEditorAdapter<typeof seed.content>(identity, 'reference', 'data');
  const client = new CollaborationClient(dataEditorCodec, adapter, { immutableContent: true });
  client.install(seed);
  deepFreeze(second.snapshot.content);
  const expectedId = second.operation.operationId;
  const received: string[] = [];
  client.onEvent = (event) => received.push(event.operation.operationId);
  client.receive(second);
  second.operation.operationId = 'caller-mutated';
  second.snapshot.stamps['caller-field'] = 123;
  second.snapshot.revision = 99;
  client.receive(first);
  expect(client.confirmed.revision).toBe(2);
  expect(client.confirmed.stamps).not.toHaveProperty('caller-field');
  expect(received).toEqual([first.operation.operationId, expectedId]);
  expect(client.confirmed.content).toBe(second.snapshot.content);

  const mutable = new CollaborationClient(dataEditorCodec, adapter);
  mutable.install(seed);
  deepFreeze(first.snapshot.content);
  mutable.receive(first);
  mutable.confirmed.content.rows[0].values[field] = 50;
  expect(first.snapshot.content.rows[0].values[field]).toBe(12);
  expect(isDeepFrozen(mutable.confirmed.content)).toBe(false);

  const shallow = structuredClone(first);
  Object.freeze(shallow.snapshot.content);
  const isolated = new CollaborationClient(dataEditorCodec, adapter, { immutableContent: true });
  isolated.install(seed);
  isolated.receive(shallow);
  shallow.snapshot.content.rows[0].values[field] = 77;
  expect(isolated.confirmed.content.rows[0].values[field]).toBe(12);
});

it('checks the mutable envelope again when an identical immutable receipt is delivered twice', () => {
  const { seed, authority } = fixture();
  const adapter = new HttpEditorAdapter<typeof seed.content>(identity, 'reference', 'data');
  const client = new CollaborationClient(dataEditorCodec, adapter, { immutableContent: true });
  client.install(seed);
  const event = authority.changes(0).events[0];
  deepFreeze(event.snapshot.content);
  client.receive(event);
  // Distinct, fully immutable trees establish an exact comparison on redelivery.
  event.snapshot.content = deepFreeze(structuredClone(event.snapshot.content));
  client.receive(event);
  client.receive(event);
  const confirmed = client.confirmed;
  event.snapshot.artifactId = 'different-artifact';
  expect(() => client.receive(event)).toThrow('identity/revision');
  event.snapshot.artifactId = seed.artifactId;
  event.snapshot.revision = -1;
  expect(() => client.receive(event)).toThrow();
  expect(client.confirmed).toBe(confirmed);
});
