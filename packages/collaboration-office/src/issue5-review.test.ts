import { describe, expect, it } from 'vitest';
import {
  Authority,
  FaultAdapter,
  initial,
  localAdapter,
  proposal,
  operation,
  type DomainCodec,
  type Principal,
} from '@editor-platform/collaboration-core';
import {
  createDeck,
  insertObject,
  updateObject,
  addSlide,
  alignObjects,
  groupObjects,
  transformObjects,
} from '@editor-platform/slide/model';
import { createWhiteboard, insertNode } from '@editor-platform/whiteboard/model';
import {
  createDesign,
  insertElement,
  makeDesignElement,
  patchDesign,
  updateElement,
  layoutDesign,
} from '@editor-platform/design/model';
import { transaction } from '@editor-platform/editor-core';
import { createDocument } from '@editor-platform/document/model';
import { documentEditorCodec } from './document-editor';
import {
  slideEditorCodec,
  whiteboardEditorCodec,
  designEditorCodec,
  prepareEditorCommand,
} from './editor-transactions';
import { SharedEditorSession, type EditorHostAdapter } from './editor-session';
const proposalHost = {
  actorId: 'host',
  clientId: 'host',
  sessionId: 'host',
  writable: true,
  scopes: ['*'],
};

const actor = (actorId: string): Principal => ({
  actorId,
  clientId: actorId,
  sessionId: actorId,
  writable: true,
  scopes: ['*'],
});
const A = actor('A'),
  B = actor('B');
async function fixture<T>(codec: DomainCodec<T>, content: T) {
  const authority = new Authority(codec, initial('review', codec, content));
  const base = localAdapter(authority, A),
    faults = new FaultAdapter(base);
  const adapter = Object.assign(faults, {
    versions: async () => [],
    undo: async (id: string, redo?: boolean) => authority.undo(A, id, redo),
    registerProposal: async (value: Parameters<typeof authority.register>[1]) =>
      authority.register(A, value),
    previewProposal: async (id: string) => authority.preview(A, id),
    applyProposal: async (id: string, token: string) => authority.applyProposal(A, id, token),
  }) as unknown as EditorHostAdapter<T>;
  const session = new SharedEditorSession(codec, adapter);
  await session.open();
  return { authority, base, faults, adapter, session };
}
function deck() {
  const d = createDeck();
  return insertObject(d.slides[0].id, 'shape', { fill: '#123456' }).apply(d);
}
describe('R5-01: own inverse history without erasing foreign writers or ABA stamps', () => {
  it('QL: serializes rapid history requests and does not report confirmed before the receipt', async () => {
    const d = deck(),
      page = d.slides[0].id,
      id = d.slides[0].objects[0].id;
    const { session, adapter, authority } = await fixture(slideEditorCodec, d);
    for (const fill of ['#ff0000', '#0000ff']) {
      session.execute(updateObject(page, id, { fill }));
      await session.flush();
    }
    const undo = adapter.undo;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    adapter.undo = async (id, redo) => {
      await held;
      return undo(id, redo);
    };
    const first = session.history('undo'),
      second = session.history('undo');
    expect(session.status).not.toContain('confirmed');
    expect(session.canUndo).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(session.content.slides[0].objects[0].fill).toBe('#123456');
    expect(authority.snapshot().revision).toBe(4);
    await Promise.all([session.history('redo'), session.history('redo')]);
    expect(session.content.slides[0].objects[0].fill).toBe('#0000ff');
    expect(authority.snapshot().revision).toBe(6);
    session.close();
  });
  it('also supports multiple text transactions in the Document and canvas engines', async () => {
    async function check<T>(codec: DomainCodec<T>, content: T, target: string) {
      const { session } = await fixture(codec, content),
        engine = session.text(target),
        original = engine.state.doc.textContent;
      for (const value of ['A', 'B']) {
        engine.dispatch(engine.state.tr.insertText(value, 1));
        await session.flush();
      }
      for (const [direction, prefix] of [
        ['undo', 'A'],
        ['undo', ''],
        ['redo', 'A'],
        ['redo', 'BA'],
      ] as const) {
        await session.history(direction);
        expect(session.lastReceipt?.status).toBe('accepted');
        expect(engine.state.doc.textContent).toBe(prefix + original);
      }
      session.close();
    }
    const d = deck();
    await check(slideEditorCodec, d, d.slides[0].objects[0].id);
    await check(documentEditorCodec, createDocument(), 'text');
  });
  it('undoes/redoes repeated field edits across independent remote edits, compaction and reload', async () => {
    const d = deck(),
      page = d.slides[0].id,
      id = d.slides[0].objects[0].id;
    const { authority, session, adapter } = await fixture(slideEditorCodec, d);
    for (const fill of ['#ff0000', '#0000ff']) {
      session.execute(updateObject(page, id, { fill }));
      await session.flush();
    }
    authority.commit(
      B,
      prepareEditorCommand(
        slideEditorCodec,
        authority.snapshot(),
        B,
        updateObject(page, id, { stroke: '#abcdef' }),
      )!,
    );
    authority.compact();
    const restored = new SharedEditorSession(slideEditorCodec, adapter);
    restored.resume(session.checkpoint());
    await restored.open();
    const beforeRevision = authority.snapshot().revision;
    for (const [direction, fill] of [
      ['undo', '#ff0000'],
      ['undo', '#123456'],
      ['redo', '#ff0000'],
      ['redo', '#0000ff'],
      ['undo', '#ff0000'],
      ['undo', '#123456'],
      ['redo', '#ff0000'],
      ['redo', '#0000ff'],
    ] as const) {
      await restored.history(direction);
      expect(restored.lastReceipt).toMatchObject({ status: 'accepted' });
      expect(authority.snapshot().content.slides[0].objects[0]).toMatchObject({
        fill,
        stroke: '#abcdef',
      });
    }
    expect(authority.snapshot().revision).toBe(beforeRevision + 8);
    restored.close();
  });
  it('undoes attribute then insertion and redoes both, while proposal history still detects ABA', async () => {
    const d = createDeck(),
      page = d.slides[0].id;
    const { authority, session } = await fixture(slideEditorCodec, d);
    session.execute(insertObject(page, 'shape', { fill: '#123456' }));
    await session.flush();
    const id = session.content.slides[0].objects[0].id;
    const prepared = prepareEditorCommand(
      slideEditorCodec,
      authority.snapshot(),
      A,
      updateObject(page, id, { fill: '#aaaaaa' }),
    )!;
    const p = proposal(
      authority,
      'C',
      prepared.actions,
      [`entity:objects@${page}:${id}`],
      'read whole element',
    );
    authority.register({ ...proposalHost, actorId: p.sourceActorId }, p);
    const preview = authority.preview(A, p.id);
    session.execute(updateObject(page, id, { fill: '#ff0000' }));
    await session.flush();
    await session.history('undo');
    expect(authority.applyProposal(A, p.id, preview.token)).toMatchObject({
      status: 'rejected',
      code: 'stale-precondition',
    });
    await session.history('undo');
    expect(session.lastReceipt?.status).toBe('accepted');
    expect(session.content.slides[0].objects).toHaveLength(0);
    for (const fill of ['#123456', '#ff0000']) {
      await session.history('redo');
      expect(session.lastReceipt?.status).toBe('accepted');
      expect(session.content.slides[0].objects[0]).toMatchObject({ id, fill });
    }
    session.close();
  });
  it('keeps foreign edit/Undo and restore barriers, including after authority backup', async () => {
    for (const restore of [false, true]) {
      const d = deck(),
        page = d.slides[0].id,
        id = d.slides[0].objects[0].id;
      const { authority, session } = await fixture(slideEditorCodec, d);
      const first = session.execute(updateObject(page, id, { fill: '#ff0000' }))!;
      await session.flush();
      if (restore)
        authority.restore(B, authority.snapshot().content, authority.snapshot().revision);
      else {
        const remote = prepareEditorCommand(
          slideEditorCodec,
          authority.snapshot(),
          B,
          updateObject(page, id, { fill: '#0000ff' }),
        )!;
        authority.commit(B, remote);
        authority.undo(B, remote.operationId);
      }
      const reloaded = Authority.fromBackup(slideEditorCodec, authority.backup());
      expect(reloaded.undo(A, first.operationId)).toMatchObject({
        status: 'rejected',
        code: 'undo-conflict',
      });
      expect(reloaded.snapshot().content.slides[0].objects[0].fill).toBe('#ff0000');
      const forged = operation(slideEditorCodec, authority.snapshot(), A, first.actions, 'undo');
      forged.undoOf = first.operationId;
      expect(authority.commit(A, forged)).toMatchObject({
        status: 'rejected',
        code: 'protocol-error',
      });
      session.close();
    }
  });
});

describe('R5-02: text on an optimistic insertion', () => {
  it('retains the original private basis if a compacted accepted insertion was subsequently restored', async () => {
    const d = createDeck(),
      { session, authority, faults, adapter } = await fixture(slideEditorCodec, d);
    faults.connected = false;
    session.execute(insertObject(d.slides[0].id, 'text', { text: '' }));
    await session.flush();
    const id = session.content.slides[0].objects[0].id,
      engine = session.text(id);
    engine.dispatch(engine.state.tr.insertText('private input', 1));
    faults.connected = true;
    faults.hold = true;
    faults.dropAck = true;
    await session.reconnect();
    const remote = authority.snapshot().content;
    remote.slides[0].objects[0].text = 'other actor restored';
    authority.restore(B, remote, authority.snapshot().revision);
    authority.compact();
    await session.sync();
    const checkpoint = session.checkpoint();
    const restored = new SharedEditorSession(slideEditorCodec, adapter);
    restored.resume(checkpoint);
    await restored.open();
    await restored.flush();
    expect(restored.text(id).state.doc.textContent).toBe('private input');
    expect(restored.text(id).conflict).toContain('basis changed');
    expect(authority.snapshot().content).toEqual(remote);
    expect(restored.pendingCount).toBe(1);
    restored.discardUnsubmitted();
    expect(restored.pendingCount).toBe(0);
    expect(restored.content).toEqual(remote);
    restored.close();
  });
  async function check<T>(
    codec: DomainCodec<T>,
    content: T,
    insert: import('@editor-platform/editor-core').EditorCommand<T>,
    target: (d: T) => string,
  ) {
    const { authority, session, faults, adapter } = await fixture(codec, content);
    faults.connected = false;
    session.execute(insert);
    await session.flush();
    const id = target(session.content),
      engine = session.text(id);
    const initialText = engine.state.doc.textContent;
    engine.dispatch(engine.state.tr.insertText('未確定の入力', 1));
    await session.flush();
    expect(session.pendingCount).toBe(2);
    // A checkpoint must include both the pending insertion and its private text basis.
    const restored = new SharedEditorSession(codec, adapter);
    restored.resume(session.checkpoint());
    faults.connected = true;
    faults.dropAck = true;
    await restored.reconnect();
    faults.dropAck = false;
    await restored.reconnect();
    await restored.flush();
    expect(restored.pendingCount).toBe(0);
    expect(restored.rejected).toHaveLength(0);
    expect(restored.text(id).state.doc.textContent).toBe(`未確定の入力${initialText}`);
    expect(restored.content).toEqual(authority.snapshot().content);
    expect(authority.snapshot().revision).toBe(2);
    expect(authority.snapshot().textVersions?.[id]).toBe(1);
    restored.close();
  }
  it('retains Slide insertion/input through disconnect, checkpoint and lost acknowledgement', async () => {
    const d = createDeck();
    await check(
      slideEditorCodec,
      d,
      insertObject(d.slides[0].id, 'text', { text: '' }),
      (d) => d.slides[0].objects[0].id,
    );
  });
  it('uses the same deferred engine for Whiteboard', async () => {
    await check(
      whiteboardEditorCodec,
      createWhiteboard(),
      insertNode('sticky'),
      (d) => d.nodes[0].id,
    );
  });
  it('uses the same deferred engine for Design', async () => {
    await check(designEditorCodec, createDesign(), insertElement('text'), (d) => d.elements[0].id);
  });
  it('retains rejected insertion input across reload and explicit re-preview, or explicit discard', async () => {
    const d = createDeck(),
      { session, authority, faults, base, adapter } = await fixture(slideEditorCodec, d);
    faults.connected = false;
    session.execute(insertObject(d.slides[0].id, 'text', { text: '' }));
    await session.flush();
    const id = session.content.slides[0].objects[0].id,
      engine = session.text(id);
    engine.dispatch(engine.state.tr.insertText('retained', 1));
    base.setPermissions({ writable: false, scopes: ['*'] });
    faults.connected = true;
    await session.reconnect();
    expect(session.rejected[0].receipt).toMatchObject({ code: 'unauthorized' });
    expect(authority.snapshot().content.slides[0].objects).toHaveLength(0);
    expect(engine.state.doc.textContent).toBe('retained');
    const checkpoint = session.checkpoint();
    const restored = new SharedEditorSession(slideEditorCodec, adapter);
    restored.resume(checkpoint);
    base.setPermissions({ writable: true, scopes: ['*'] });
    await restored.open();
    const { id: proposalId, preview } = await restored.previewRetained();
    await restored.applyProposal(proposalId, preview.token);
    await restored.flush();
    expect(restored.pendingCount).toBe(0);
    expect(authority.snapshot().content.slides[0].objects[0]).toMatchObject({
      id,
      text: 'retained',
    });
    restored.close();
    const discarded = new SharedEditorSession(slideEditorCodec, adapter);
    discarded.resume(checkpoint);
    discarded.discardRetained();
    expect(discarded.pendingCount).toBe(0);
    expect(discarded.rejected).toHaveLength(0);
    discarded.close();
  });
  it('explicitly cancels unsent insertion and text together without a deleted-target exception', async () => {
    const d = createDeck(),
      { session, faults, authority } = await fixture(slideEditorCodec, d);
    faults.connected = false;
    session.execute(insertObject(d.slides[0].id, 'text', { text: '' }));
    await session.flush();
    const id = session.content.slides[0].objects[0].id,
      engine = session.text(id);
    engine.dispatch(engine.state.tr.insertText('cancelled', 1));
    expect(session.checkpoint().text[0].steps.length).toBeGreaterThan(0);
    session.discardUnsubmitted();
    expect(session.pendingCount).toBe(0);
    faults.connected = true;
    await session.reconnect();
    expect(authority.snapshot().content).toEqual(d);
    session.close();
  });
  it('starts typing while the insertion submit is in flight and connects only after acceptance', async () => {
    const d = createDeck(),
      { session, adapter, authority } = await fixture(slideEditorCodec, d);
    const original = adapter.submit.bind(adapter);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let submits = 0;
    adapter.submit = async (op) => {
      submits++;
      if (submits === 1) {
        entered();
        await gate;
      }
      return original(op);
    };
    session.execute(insertObject(d.slides[0].id, 'text', { text: '' }));
    await started;
    const id = session.content.slides[0].objects[0].id,
      engine = session.text(id);
    engine.dispatch(engine.state.tr.insertText('during submit', 1));
    expect(authority.snapshot().revision).toBe(0);
    expect(submits).toBe(1);
    release();
    await session.flush();
    expect(submits).toBe(2);
    expect(authority.snapshot().content.slides[0].objects[0].text).toBe('during submit');
    session.close();
  });
});

describe('R5-03: scoped geometry dependencies', () => {
  it('accepts independent moves on different pages and rejects a stale move of the same object', () => {
    let d = addSlide().apply(deck());
    d = insertObject(d.slides[1].id, 'shape').apply(d);
    const authority = new Authority(slideEditorCodec, initial('pages', slideEditorCodec, d)),
      snapshot = authority.snapshot();
    const moves = d.slides.map(
      (page, i) =>
        prepareEditorCommand(
          slideEditorCodec,
          snapshot,
          i ? B : A,
          updateObject(page.id, page.objects[0].id, {
            bounds: { ...page.objects[0].bounds, x: i ? 500 : 100 },
          }),
        )!,
    );
    const stale = prepareEditorCommand(
      slideEditorCodec,
      snapshot,
      B,
      updateObject(d.slides[0].id, d.slides[0].objects[0].id, {
        bounds: { ...d.slides[0].objects[0].bounds, y: 100 },
      }),
    )!;
    expect(authority.commit(A, moves[0]).status).toBe('accepted');
    expect(authority.commit(B, moves[1]).status).toBe('accepted');
    expect(authority.commit(B, stale)).toMatchObject({
      status: 'rejected',
      code: 'stale-precondition',
    });
    expect(authority.snapshot().content.slides.map((s) => s.objects[0].bounds.x)).toEqual([
      100, 500,
    ]);
  });
  it('pins an unchanged alignment reference and group descendants, but allows independent colors', () => {
    let d = deck();
    const page = d.slides[0].id;
    d = insertObject(page, 'shape', { bounds: { x: 600, y: 100, width: 100, height: 100 } }).apply(
      d,
    );
    const [a, b] = d.slides[0].objects;
    const authority = new Authority(slideEditorCodec, initial('align', slideEditorCodec, d));
    const align = prepareEditorCommand(
      slideEditorCodec,
      authority.snapshot(),
      A,
      transaction('align selection', [alignObjects(page, [a.id, b.id], 'left')]),
    )!;
    const remote = prepareEditorCommand(
      slideEditorCodec,
      authority.snapshot(),
      B,
      updateObject(page, a.id, { bounds: { ...a.bounds, x: 99 } }),
    )!;
    authority.commit(B, remote);
    expect(authority.commit(A, align)).toMatchObject({
      status: 'rejected',
      code: 'stale-precondition',
    });
    d = groupObjects(page, [a.id, b.id]).apply(d);
    const group = d.slides[0].objects[0];
    const grouped = new Authority(slideEditorCodec, initial('group', slideEditorCodec, d));
    const move = prepareEditorCommand(
      slideEditorCodec,
      grouped.snapshot(),
      A,
      transformObjects(page, [group.id], { dx: 10, dy: 0, dw: 0, dh: 0 }),
    )!;
    grouped.commit(
      B,
      prepareEditorCommand(
        slideEditorCodec,
        grouped.snapshot(),
        B,
        updateObject(page, a.id, { fill: '#112233' }),
      )!,
    );
    expect(grouped.commit(A, move).status).toBe('accepted');
    const next = prepareEditorCommand(
      slideEditorCodec,
      grouped.snapshot(),
      A,
      transformObjects(page, [group.id], { dx: 10, dy: 0, dw: 0, dh: 0 }),
    )!;
    const child = grouped.snapshot().content.slides[0].objects.find((o) => o.id === a.id)!;
    grouped.commit(
      B,
      prepareEditorCommand(
        slideEditorCodec,
        grouped.snapshot(),
        B,
        updateObject(page, a.id, { bounds: { ...child.bounds, width: 300 } }),
      )!,
    );
    expect(grouped.commit(A, next)).toMatchObject({
      status: 'rejected',
      code: 'stale-precondition',
    });
  });
  it('detects group membership ABA even when a new child was subsequently undone', () => {
    let d = deck();
    const page = d.slides[0].id;
    d = insertObject(page, 'shape').apply(d);
    d = groupObjects(
      page,
      d.slides[0].objects.map((o) => o.id),
    ).apply(d);
    const group = d.slides[0].objects[0],
      authority = new Authority(slideEditorCodec, initial('membership', slideEditorCodec, d));
    const move = prepareEditorCommand(
      slideEditorCodec,
      authority.snapshot(),
      A,
      transformObjects(page, [group.id], { dx: 40, dy: 0, dw: 0, dh: 0 }),
    )!;
    const insert = prepareEditorCommand(
      slideEditorCodec,
      authority.snapshot(),
      B,
      insertObject(page, 'shape', { groupId: group.id }),
    )!;
    expect(authority.commit(B, insert).status).toBe('accepted');
    expect(authority.undo(B, insert.operationId).status).toBe('accepted');
    expect(authority.commit(A, move)).toMatchObject({
      status: 'rejected',
      code: 'stale-precondition',
    });
  });
  it('allows separate auto-layout Frames while detecting a related sibling geometry change', () => {
    const frame = makeDesignElement('frame'),
      otherFrame = makeDesignElement('frame');
    frame.layout = otherFrame.layout = {
      direction: 'row',
      gap: 12,
      padding: 20,
      align: 'start',
      sizing: 'fixed',
    };
    const children = [frame, frame, otherFrame].map((parent) => ({
      ...makeDesignElement('shape'),
      parentId: parent.id,
    }));
    const d = layoutDesign({ ...createDesign(), elements: [frame, otherFrame, ...children] });
    for (const related of [false, true]) {
      const authority = new Authority(designEditorCodec, initial('frames', designEditorCodec, d)),
        snapshot = authority.snapshot();
      const a = prepareEditorCommand(
        designEditorCodec,
        snapshot,
        A,
        patchDesign([children[0].id], { bounds: { ...children[0].bounds, width: 180 } }),
      )!;
      const b = children[related ? 1 : 2];
      const remote = prepareEditorCommand(
        designEditorCodec,
        snapshot,
        B,
        patchDesign([b.id], { bounds: { ...b.bounds, width: 240 } }),
      )!;
      expect(authority.commit(B, remote).status).toBe('accepted');
      expect(authority.commit(A, a).status).toBe(related ? 'rejected' : 'accepted');
    }
    const authority = new Authority(designEditorCodec, initial('color', designEditorCodec, d));
    const move = prepareEditorCommand(
      designEditorCodec,
      authority.snapshot(),
      A,
      patchDesign([children[0].id], { bounds: { ...children[0].bounds, width: 180 } }),
    )!;
    authority.commit(
      B,
      prepareEditorCommand(
        designEditorCodec,
        authority.snapshot(),
        B,
        updateElement(children[1].id, { fill: '#abcdef' }),
      )!,
    );
    expect(authority.commit(A, move).status).toBe('accepted');
    expect(authority.snapshot().content.elements.find((e) => e.id === children[1].id)?.fill).toBe(
      '#abcdef',
    );
  });
});
