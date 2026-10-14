import { expect, it } from 'vitest';
import { deepFreeze, isDeepFrozen } from '@editor-platform/artifact-core';
import {
  evaluate,
  Authority,
  CollaborationClient,
  localAdapter,
  initial,
  type DomainCodec,
  type Identity,
  type Action,
} from '@editor-platform/collaboration-core';
import { command, type EditorCommand } from '@editor-platform/editor-core';
import { createDeck, insertObject, transformObjects } from '@editor-platform/slide/model';
import { createDesign, insertElement, transformElements } from '@editor-platform/design/model';
import { createWhiteboard, insertNode } from '@editor-platform/whiteboard/model';
import { transformBoardCommand } from '@editor-platform/whiteboard';
import { createData, addRow, setCell } from '@editor-platform/structured-data';
import type { DocumentContent } from '@editor-platform/document/model';
import { contentToNode } from '@editor-platform/document/engine';
import { EditorState } from 'prosemirror-state';
import { documentEditorCodec } from './document-editor';
import {
  dataEditorCodec,
  designEditorCodec,
  slideEditorCodec,
  whiteboardEditorCodec,
  prepareEditorCommand,
} from './editor-transactions';

const identity: Identity = { actorId: 'A', clientId: 'A', sessionId: 'A' };
const delta = { dx: 12, dy: 3, dw: 0, dh: 0 };
it('Document immutable evaluation preserves text, attribute, page and restore semantics without borrowing writes', () => {
  const content: DocumentContent = {
    schemaVersion: 2,
    page: { size: 'A4', margin: 24 },
    blocks: [{ id: 'body', type: 'paragraph', text: '本文' }],
  };
  let basis = deepFreeze(
    initial('document-immutable', documentEditorCodec, content, [
      {
        id: 'comment',
        resolved: false,
        replies: [],
        anchor: { type: 'text', from: 1, to: 2 },
      },
    ]),
  );
  const original = structuredClone(basis);
  const tr = EditorState.create({ doc: contentToNode(content) }).tr.insertText('追記', 2);
  const actions: Action[] = [
    {
      type: 'document.steps',
      target: 'text',
      payload: { version: 0, steps: tr.steps.map((s) => s.toJSON()) },
    },
    {
      type: 'document.attributes',
      target: 'text',
      payload: { patches: [{ id: 'body', values: { style: { color: '#336699' } } }] },
    },
    { type: 'document.page', target: '*', payload: { value: { size: 'Letter', margin: 32 } } },
    { type: 'document.page', target: '*', payload: { value: null } },
    { type: 'domain.restore', target: '*', payload: { content } },
  ];
  for (const action of deepFreeze(actions)) {
    const before = structuredClone(basis);
    const retained = evaluate(documentEditorCodec, basis, [action], identity.actorId, {
      immutableContent: true,
    });
    const copied = evaluate(
      { ...documentEditorCodec, applyReadonly: undefined },
      basis,
      [action],
      identity.actorId,
    );
    expect(retained).toEqual(copied);
    expect(basis).toEqual(before);
    expect(isDeepFrozen(retained.state.content)).toBe(true);
    basis = retained.state;
  }
  expect(basis.content.blocks[0].text).toBe(original.content.blocks[0].text);
  expect(basis.threads[0].anchor.orphan).toBe(true);
  const page = { size: 'A4' as const, margin: 30 };
  const effect = documentEditorCodec.applyReadonly!(
    basis.content,
    {
      type: 'document.page',
      target: '*',
      payload: { value: page },
    },
    basis.engineVersion,
  );
  page.margin = 90;
  expect(effect.content.page!.margin).toBe(30);
  expect(basis.content.page!.margin).toBe(24);
});
it('authority owns immutable native state while snapshots, events and selective history remain isolated', () => {
  const content = addRow().apply(addRow().apply(createData()));
  const seen: (typeof content)[] = [];
  const codec: DomainCodec<typeof content> = {
    ...dataEditorCodec,
    applyReadonly(source, ...args) {
      seen.push(source);
      return dataEditorCodec.applyReadonly!(source, ...args);
    },
  };
  const input = initial('owned-authority', codec, content);
  const authority = new Authority(codec, input);
  const principal = { ...identity, writable: true, scopes: ['*'] };
  const row = content.rows[0].id,
    field = content.columns[2].id;
  input.content.rows[1].values[field] = 999;
  const original = authority.snapshot();
  expect(original.content.rows[1].values[field]).toBe(1);
  expect(isDeepFrozen(input.content)).toBe(false);
  const op = prepareEditorCommand(codec, original, identity, setCell(row, field, 12))!;
  original.content.rows[1].values[field] = 888;
  seen.length = 0;
  authority.subscribe((event) => {
    event.snapshot.content.rows[1].values[field] = 777;
    event.inverse.length = 0;
  });
  expect(authority.submit(principal, op).status).toBe('accepted');
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every(isDeepFrozen)).toBe(true);
  expect(authority.snapshot().content.rows[0].values[field]).toBe(12);
  expect(authority.snapshot().content.rows[1].values[field]).toBe(1);
  const undo = authority.undo(principal, op.operationId);
  expect(undo.status).toBe('accepted');
  expect(authority.snapshot().content).toEqual(content);
  expect(authority.undo(principal, undo.operationId, true).status).toBe('accepted');
  expect(authority.snapshot().content.rows[0].values[field]).toBe(12);
  const snapshot = authority.snapshot();
  snapshot.content.rows[0].values[field] = 666;
  expect(authority.snapshot().content.rows[0].values[field]).toBe(12);
  const next = prepareEditorCommand(
    codec,
    authority.snapshot(),
    identity,
    setCell(row, field, 14),
  )!;
  authority.register({
    schema: 1,
    id: 'isolated-preview',
    artifactId: next.artifactId,
    sourceActorId: identity.actorId,
    baseRevision: next.baseRevision,
    summary: 'Change quantity',
    actions: next.actions,
    reads: next.conditions,
    writes: next.conditions,
    external: [],
  });
  const preview = authority.preview(principal, 'isolated-preview');
  preview.before.rows[0].values[field] = 555;
  preview.after.rows[1].values[field] = 444;
  expect(authority.snapshot().content.rows[1].values[field]).toBe(1);
  expect(authority.applyProposal(principal, 'isolated-preview', preview.token).status).toBe(
    'accepted',
  );
  expect(authority.snapshot().content.rows[0].values[field]).toBe(14);
  expect(authority.snapshot().content.rows[1].values[field]).toBe(1);
});
it('reuses exactly confirmed immutable optimistic content while retaining authority metadata and remote changes', async () => {
  const content = addRow().apply(createData());
  const authority = new Authority(
    dataEditorCodec,
    initial('confirmation-identity', dataEditorCodec, content),
  );
  const principal = { ...identity, writable: true, scopes: ['*'] };
  const client = new CollaborationClient(dataEditorCodec, localAdapter(authority, principal), {
    immutableContent: true,
  });
  await client.open();
  const row = content.rows[0].id,
    quantity = content.columns[2].id,
    name = content.columns[0].id;
  const op = prepareEditorCommand(
    dataEditorCodec,
    client.confirmed,
    identity,
    setCell(row, quantity, 12),
  )!;
  client.enqueue(op);
  const painted = client.optimistic.content;
  await client.submit(op);
  expect(client.confirmed.content).toBe(painted);
  expect(client.optimistic.content).toBe(painted);
  expect(client.confirmed.revision).toBe(1);
  expect(client.pending).toEqual([]);
  expect(client.receipts.get(op.operationId)?.status).toBe('accepted');
  expect(Object.values(client.confirmed.stamps)).toContain(1);

  const next = prepareEditorCommand(
    dataEditorCodec,
    client.confirmed,
    identity,
    setCell(row, quantity, 13),
  )!;
  client.enqueue(next);
  const beforeRemote = client.optimistic.content;
  const peer = { ...principal, actorId: 'B', sessionId: 'B', clientId: 'B' };
  const remote = prepareEditorCommand(
    dataEditorCodec,
    authority.snapshot(),
    peer,
    setCell(row, name, 'Remote name'),
  )!;
  expect(authority.submit(peer, remote).status).toBe('accepted');
  await client.sync();
  expect(client.confirmed.content).not.toBe(beforeRemote);
  expect(client.optimistic.content.rows[0].values[name]).toBe('Remote name');
  expect(client.optimistic.content.rows[0].values[quantity]).toBe(13);
  const merged = client.optimistic.content;
  await client.submit(next);
  expect(client.confirmed.content).toBe(merged);
  expect(client.confirmed.revision).toBe(3);
  expect(painted.rows[0].values[name]).not.toBe('Remote name');
  client.close();
});
it('immutable client views retain isolated history while ordinary client views remain mutable', async () => {
  const content = addRow().apply(addRow().apply(createData()));
  const authority = new Authority(
    dataEditorCodec,
    initial('owned-views', dataEditorCodec, content),
  );
  const principal = { ...identity, writable: true, scopes: ['*'] };
  const client = new CollaborationClient(dataEditorCodec, localAdapter(authority, principal), {
    immutableContent: true,
  });
  const legacy = new CollaborationClient(dataEditorCodec, localAdapter(authority, principal));
  await client.open();
  await legacy.open();
  const basis = client.confirmed.content,
    field = content.columns[2].id;
  const op = prepareEditorCommand(
    dataEditorCodec,
    client.confirmed,
    identity,
    setCell(content.rows[0].id, field, 12),
  )!;
  client.enqueue(op);
  expect(client.optimistic.content.rows[0].values[field]).toBe(12);
  expect(basis.rows[0].values[field]).toBe(1);
  expect(client.optimistic.content.rows[1]).toBe(basis.rows[1]);
  expect(() => {
    client.optimistic.content.rows[0].values[field] = 99;
  }).toThrow();
  legacy.optimistic.content.rows[0].values[field] = 99;
  expect(legacy.confirmed.content.rows[0].values[field]).toBe(1);
  const checkpoint = client.checkpoint();
  checkpoint.confirmed.content.rows[0].values[field] = 77;
  expect(client.confirmed.content.rows[0].values[field]).toBe(1);
  await client.submit(op);
  expect(client.confirmed.content.rows[0].values[field]).toBe(12);
  expect(client.optimistic.content).toEqual(client.confirmed.content);
  expect(basis.rows[0].values[field]).toBe(1);
  client.close();
  legacy.close();
});
it('immutable evaluation never borrows the mutable children of a shallow-frozen Host snapshot', () => {
  const content = addRow().apply(addRow().apply(createData()));
  const state = initial('shallow', dataEditorCodec, content);
  Object.freeze(state.content);
  const field = content.columns[2].id;
  const op = prepareEditorCommand(
    dataEditorCodec,
    state,
    identity,
    setCell(content.rows[0].id, field, 12),
  )!;
  const result = evaluate(dataEditorCodec, state, op.actions, identity.actorId, {
    immutableContent: true,
  });
  state.content.rows[1].values[field] = 99;
  expect(result.state.content.rows[1].values[field]).toBe(1);
  expect(() => {
    result.state.content.rows[0].values[field] = 99;
  }).toThrow();
});
function verify<T>(codec: DomainCodec<T>, content: T, edit: EditorCommand<T>) {
  const state = deepFreeze(initial('immutable-preparation', codec, content));
  const original = structuredClone(state);
  const fast = prepareEditorCommand(codec, state, identity, edit)!;
  const copied = prepareEditorCommand(
    { ...codec, applyReadonly: undefined },
    state,
    identity,
    edit,
  )!;
  expect(fast.actions).toEqual(copied.actions);
  expect(fast.conditions).toEqual(copied.conditions);
  expect(fast.targets).toEqual(copied.targets);
  expect(fast.actions).toHaveLength(1);
  const effect = codec.applyReadonly!(state.content, fast.actions[0], 0);
  expect(effect.content).not.toEqual(state.content);
  const inverse = evaluate(
    codec,
    initial('immutable-preparation', codec, effect.content),
    effect.inverse,
    identity.actorId,
  );
  expect(inverse.state.content).toEqual(state.content);
  expect(state).toEqual(original);
  return { state, fast, effect };
}
it('pure Slide preparation preserves page fields and nested object fields together', () => {
  const deck = createDeck(),
    page = deck.slides[0].id;
  const content = insertObject(page, 'shape').apply(deck);
  verify(
    slideEditorCodec,
    content,
    transformObjects(page, [content.slides[0].objects[0].id], delta),
  );
  const { effect } = verify(
    slideEditorCodec,
    content,
    command('host-edit', 'Page and object', (d) => {
      d.slides[0].title = 'Changed page';
      d.slides[0].objects[0].fill = '#123456';
      return d;
    }),
  );
  expect(effect.content.slides[0].title).toBe('Changed page');
  expect(effect.content.slides[0].objects[0].fill).toBe('#123456');
});
it('certifies privately staged Slide results without freezing mutable Host branches or action payloads', () => {
  const deck = createDeck(),
    page = deck.slides[0].id;
  const content = insertObject(page, 'shape').apply(deck);
  const source = deepFreeze(content);
  const bounds = { ...source.slides[0].objects[0].bounds, x: 123 };
  const action: Action = {
    type: 'slide.edit',
    target: '*',
    payload: {
      reads: [],
      changes: [
        {
          kind: 'field',
          collection: 'objects@' + page,
          id: source.slides[0].objects[0].id,
          field: 'bounds',
          value: bounds,
        },
      ],
    },
  };
  const effect = slideEditorCodec.applyReadonly!(source, action, 0);
  expect(isDeepFrozen(effect.content)).toBe(true);
  bounds.x = 456;
  expect(effect.content.slides[0].objects[0].bounds.x).toBe(123);
  const mutable = structuredClone(source);
  Object.freeze(mutable);
  slideEditorCodec.applyReadonly!(mutable, action, 0);
  mutable.slides[0].objects[0].text = 'Host edit';
  expect(isDeepFrozen(mutable.slides)).toBe(false);
  expect(source.slides[0].objects[0].text).not.toBe('Host edit');
});
it('pure Design preparation keeps geometry dependencies and inverse content', () => {
  const content = insertElement('frame').apply(createDesign());
  verify(designEditorCodec, content, transformElements([content.elements[0].id], delta));
});
it('pure Whiteboard preparation keeps geometry dependencies and inverse content', () => {
  const content = insertNode('sticky').apply(createWhiteboard());
  verify(whiteboardEditorCodec, content, transformBoardCommand([content.nodes[0].id], delta));
});
it('pure Data preparation shares only unchanged branches; public evaluation stays isolated', () => {
  const content = addRow().apply(addRow().apply(createData()));
  const { state, fast, effect } = verify(
    dataEditorCodec,
    content,
    setCell(content.rows[0].id, content.columns[2].id, 12),
  );
  expect(effect.content.rows[1]).toBe(state.content.rows[1]);
  const result = evaluate(dataEditorCodec, state, fast.actions, identity.actorId);
  result.state.content.rows[1].values[content.columns[2].id] = 99;
  expect(state.content.rows[1].values[content.columns[2].id]).toBe(1);
});
it('a failed pure Data edit does not leave an earlier cell write in the source', () => {
  const source = deepFreeze(addRow().apply(createData()));
  expect(() =>
    dataEditorCodec.applyReadonly!(
      source,
      {
        type: 'data.edit',
        target: '*',
        payload: {
          reads: [],
          changes: [
            { kind: 'cell', rowId: source.rows[0].id, columnId: source.columns[2].id, value: 12 },
            { kind: 'cell', rowId: source.rows[0].id, columnId: source.columns[4].id, value: 99 },
          ],
        },
      },
      0,
    ),
  ).toThrow('Computed/read-only');
  expect(source.rows[0].values[source.columns[2].id]).toBe(1);
});
