import { it, expect } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { sendableSteps } from 'prosemirror-collab';
import {
  Authority,
  initial,
  localAdapter,
  operation,
  FaultAdapter,
} from '@editor-platform/collaboration-core';
import { documentSchema } from '@editor-platform/document/engine';
import { documentCodec, DocumentReplica } from './document';
import { documentFixture, person } from './fixtures';
async function setup() {
  const authority = new Authority(
      documentCodec,
      initial('document', documentCodec, documentFixture()),
    ),
    a = new DocumentReplica(localAdapter(authority, person('A'))),
    b = new DocumentReplica(localAdapter(authority, person('B')));
  await Promise.all([a.open(), b.open()]);
  return { authority, a, b };
}
it('a polling acknowledgement before the submit response preserves the next local edit', async () => {
  const { authority, b } = await setup();
  const base = localAdapter(authority, person('A'));
  let release!: () => void, accepted!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const committed = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  let submissions = 0;
  const a = new DocumentReplica({
    ...base,
    submit: async (op) => {
      const receipt = await base.submit(op);
      if (++submissions === 1) {
        accepted();
        await held;
      }
      return receipt;
    },
  });
  await a.open();
  a.dispatch(a.state.tr.insertText('日本語', 1));
  const first = a.flush();
  await committed;
  await Promise.all([a.sync(), a.sync()]);
  expect(sendableSteps(a.state)).toBeNull();
  a.dispatch(a.state.tr.addMark(1, 4, documentSchema.marks.bold.create()));
  const second = a.flush();
  release();
  await Promise.all([first, second]);
  await b.sync();
  expect(sendableSteps(a.state)).toBeNull();
  expect(a.state.doc.toJSON()).toEqual(b.state.doc.toJSON());
  expect(JSON.stringify(b.state.doc.toJSON())).toContain('bold');
  expect(authority.snapshot().engineVersion).toBe(2);
  expect(submissions).toBe(2);
});
it('CO-Q02 concurrent engine insert, delete and marks rebase, including anchored comments', async () => {
  const { authority, a, b } = await setup();
  authority.commit(
    person('A'),
    operation(documentCodec, authority.snapshot(), person('A'), [
      {
        type: 'thread.create',
        target: 'comment',
        payload: { anchor: { type: 'text', from: 7, to: 12 } },
      },
    ]),
  );
  a.dispatch(a.state.tr.insertText('A', 1));
  b.dispatch(b.state.tr.insertText('B', 1));
  await Promise.all([a.flush(), b.flush()]);
  await Promise.all([a.sync(), b.sync()]);
  expect(a.state.doc.toJSON()).toEqual(b.state.doc.toJSON());
  expect(a.state.doc.textContent).toContain('Hello world');
  expect(a.state.doc.textContent).toMatch(/ABHello|BAHello/);
  expect(authority.snapshot().threads[0].anchor).toMatchObject({ from: 9, to: 14 });
  a.dispatch(a.state.tr.delete(3, 5));
  b.dispatch(b.state.tr.addMark(5, 8, documentSchema.marks.bold.create()));
  await Promise.all([a.flush(), b.flush()]);
  await Promise.all([a.sync(), b.sync()]);
  expect(a.state.doc.toJSON()).toEqual(b.state.doc.toJSON());
  expect(sendableSteps(a.state)).toBeNull();
  expect(JSON.stringify(a.state.doc.toJSON())).toContain('bold');
});
it('CO-Q02 paragraph split/merge has stable IDs and Japanese composition is a transaction', async () => {
  const { a, b, authority } = await setup();
  a.dispatch(a.state.tr.setSelection(TextSelection.create(a.state.doc, 6)).split(6));
  b.dispatch(b.state.tr.insertText('日本語', 2));
  await Promise.all([a.flush(), b.flush()]);
  await Promise.all([a.sync(), b.sync()]);
  expect(a.state.doc.toJSON()).toEqual(b.state.doc.toJSON());
  expect(documentCodec.validate(authority.snapshot().content)).toBe(true);
  const boundary = a.state.doc.child(0).nodeSize;
  a.dispatch(a.state.tr.join(boundary));
  await a.flush();
  await b.sync();
  expect(a.state.doc.toJSON()).toEqual(b.state.doc.toJSON());
  expect(a.state.doc.textContent).toContain('日本語');
});
it('text lost ack retries exactly once, preserves subsequent local steps', async () => {
  const { authority, b } = await setup(),
    fault = new FaultAdapter(localAdapter(authority, person('A'))),
    a = new DocumentReplica(fault);
  await a.open();
  fault.dropAck = true;
  a.dispatch(a.state.tr.insertText('X', 1));
  await expect(a.flush()).rejects.toThrow('Acknowledgement lost');
  a.dispatch(a.state.tr.insertText('Y', 2));
  await a.flush();
  await b.sync();
  expect(a.state.doc.toJSON()).toEqual(b.state.doc.toJSON());
  expect(a.state.doc.textContent).toContain('XYHello');
  expect(authority.snapshot().engineVersion).toBe(2);
});
it('text shared Undo/Redo propagates and unsafe overlapping remote text is protected', async () => {
  const { a, b, authority } = await setup();
  a.dispatch(a.state.tr.insertText('A', 1));
  await a.flush();
  const first = a.lastReceipt!;
  const undo = authority.undo(person('A'), first.operationId);
  expect(undo.status).toBe('accepted');
  await Promise.all([a.sync(), b.sync()]);
  expect(a.state.doc.textContent).toBe('Hello worldSecond paragraph');
  const redo = authority.undo(person('A'), undo.operationId, true);
  expect(redo.status).toBe('accepted');
  await Promise.all([a.sync(), b.sync()]);
  expect(a.state.doc.toJSON()).toEqual(b.state.doc.toJSON());
  b.dispatch(b.state.tr.insertText('B', 2));
  await b.flush();
  const unsafe = authority.undo(person('A'), redo.operationId);
  expect(unsafe).toMatchObject({ status: 'rejected', code: 'undo-conflict' });
  expect(authority.snapshot().content.blocks[0].text).toContain('ABHello');
});
it('text compaction preserves unconfirmed engine steps for explicit review, never pushes old snapshot', async () => {
  const { a, b, authority } = await setup();
  a.dispatch(a.state.tr.insertText('pending', 1));
  b.dispatch(b.state.tr.insertText('remote', 1));
  await b.flush();
  authority.compact();
  await expect(a.sync()).rejects.toThrow('pending text retained');
  expect(sendableSteps(a.state)?.steps).toHaveLength(1);
  expect(authority.snapshot().content.blocks[0].text).toBe('remoteHello world');
});
it('text presence is mapped through the same engine steps and remains ephemeral', async () => {
  const { a, authority } = await setup();
  authority.presence(person('B'), {
    name: 'B',
    color: '#0000ff',
    anchor: { type: 'text', from: 7, to: 12 },
  });
  a.dispatch(a.state.tr.insertText('日本語', 1));
  await a.flush();
  expect(authority.presenceList()[0].anchor).toMatchObject({ from: 10, to: 15 });
  expect(authority.snapshot()).not.toHaveProperty('presence');
});
it('CO-Q04 engine inverse rebases over an independently edited paragraph', async () => {
  const { a, b, authority } = await setup();
  a.dispatch(a.state.tr.insertText('A', 1));
  await a.flush();
  const own = a.lastReceipt!;
  await b.sync();
  const second = b.state.doc.child(0).nodeSize + 1;
  b.dispatch(b.state.tr.insertText('B', second));
  await b.flush();
  expect(authority.undo(person('A'), own.operationId).status).toBe('accepted');
  await Promise.all([a.sync(), b.sync()]);
  expect(a.state.doc.toJSON()).toEqual(b.state.doc.toJSON());
  expect(a.state.doc.textContent).toBe('Hello worldBSecond paragraph');
});
it('text pending checkpoint resumes without double replay after a lost acknowledgement', async () => {
  const { authority } = await setup(),
    fault = new FaultAdapter(localAdapter(authority, person('A'))),
    a = new DocumentReplica(fault);
  await a.open();
  a.dispatch(a.state.tr.insertText('pending', 1));
  fault.dropAck = true;
  await expect(a.flush()).rejects.toThrow('Acknowledgement lost');
  const resumed = new DocumentReplica(localAdapter(authority, person('A')));
  resumed.resume(a.checkpoint());
  await resumed.flush();
  expect(resumed.state.doc.textContent).toBe('pendingHello worldSecond paragraph');
  expect(authority.snapshot().engineVersion).toBe(1);
});
it('presence withholds optimistic positions and maps delayed canonical cursors through remote and pending steps', async () => {
  const { a, b, authority } = await setup();
  const old = { type: 'text' as const, from: 7, to: 12 };
  a.dispatch(a.state.tr.insertText('prefix', 1));
  expect(a.presencePosition().anchor).toBeUndefined();
  expect(a.localAnchor(old)).toMatchObject({ from: 13, to: 18 });
  await a.flush();
  const values = authority.presence(person('B'), {
    name: 'B',
    color: '#0000ff',
    basis: 0,
    anchor: old,
  });
  expect(values[0]).toMatchObject({ basis: 1, anchor: { from: 13, to: 18 } });
  await b.sync();
  b.dispatch(b.state.tr.insertText('local', 1));
  expect(b.localAnchor(old, 0)).toMatchObject({ from: 18, to: 23 });
  expect(b.presencePosition().anchor).toBeUndefined();
  await b.flush();
  expect(b.presencePosition()).toMatchObject({ basis: 2, anchor: { type: 'text' } });
});
it('deleting a referenced range orphans a delayed cursor instead of relocating it onto other text', async () => {
  const { a, authority } = await setup();
  a.dispatch(a.state.tr.delete(1, 6));
  await a.flush();
  const values = authority.presence(person('B'), {
    name: 'B',
    color: '#0000ff',
    basis: 0,
    anchor: { type: 'text', from: 1, to: 6 },
  });
  expect(values[0].anchor).toMatchObject({ orphan: true });
});
