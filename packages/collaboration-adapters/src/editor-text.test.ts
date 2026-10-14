import { describe, expect, it } from 'vitest';
import {
  Authority,
  initial,
  localAdapter,
  FaultAdapter,
  type Principal,
  type DomainCodec,
} from '@editor-platform/collaboration-core';
import { createDeck, insertObject, deleteObjects } from '@editor-platform/slide/model';
import { createDocument } from '@editor-platform/document/model';
import { documentCodec } from './document';
import { documentEditorCodec } from './document-editor';
import { slideEditorCodec, prepareEditorCommand } from './editor-transactions';
import { SharedEditorSession, type EditorHostAdapter } from './editor-session';
import { canvasTextSchema } from '@editor-platform/canvas-ui/text-engine';
function actor(actorId: string): Principal {
  return { actorId, clientId: actorId, sessionId: actorId, writable: true, scopes: ['*'] };
}
async function pair<T>(codec: DomainCodec<T>, content: T) {
  const authority = new Authority(codec, initial('text-artifact', codec, content)),
    a = actor('A'),
    b = actor('B');
  const make = async (principal: Principal) => {
    const base = localAdapter(authority, principal),
      faults = new FaultAdapter(base);
    const adapter = Object.assign(faults, {
      versions: async () => [],
      undo: async (id: string, redo?: boolean) => authority.undo(principal, id, redo),
    }) as unknown as EditorHostAdapter<T>;
    const session = new SharedEditorSession(codec, adapter);
    await session.open();
    return { session, base, faults };
  };
  return { authority, a: await make(a), b: await make(b) };
}
function canvas() {
  const d = createDeck();
  return insertObject(d.slides[0].id, 'text', { text: 'hello' }).apply(d);
}
describe('normal editing session text engines', () => {
  it('keeps owned Document metadata while projecting pending text, and observes peer mode changes through Undo', async () => {
    const content = createDocument();
    content.reuse = { schemaVersion: 1, instances: [], closures: [], artifactMode: 'light' };
    const { a, b, authority } = await pair(documentEditorCodec, content);
    try {
      const original = a.session.confirmed.content;
      const engine = a.session.text('text');
      engine.dispatch(engine.state.tr.insertText('draft', 1));
      const view = a.session.viewContent;
      expect(view.reuse).toBe(original.reuse);
      expect(view.blocks[0].text).toContain('draft');
      expect(original.blocks[0].text).not.toContain('draft');
      expect(() => {
        view.reuse!.artifactMode = 'changed';
      }).toThrow();
      const publicCopy = a.session.content;
      publicCopy.reuse!.artifactMode = 'changed';
      publicCopy.blocks[0].text = 'changed';
      expect(a.session.viewContent.reuse!.artifactMode).toBe('light');
      expect(a.session.viewContent.blocks[0].text).toContain('draft');
      await a.session.flush();
      b.session.actions([{ type: 'reuse.mode', target: '*', payload: { value: 'dark' } }]);
      await b.session.flush();
      await a.session.sync();
      engine.dispatch(engine.state.tr.insertText('next', 1));
      expect(a.session.viewContent.reuse).toBe(a.session.client.optimistic.content.reuse);
      expect(a.session.viewContent.reuse!.artifactMode).toBe('dark');
      await a.session.flush();
      await a.session.history('undo');
      expect(a.session.content.blocks[0].text).toContain('draft');
      expect(a.session.content.blocks[0].text).not.toContain('next');
      expect(a.session.content.reuse!.artifactMode).toBe('dark');
      expect(a.session.content).toEqual(authority.snapshot().content);
    } finally {
      a.session.close();
      b.session.close();
    }
  });
  it('QL: deleting confirmed text does not claim lost input; compaction and Undo reconnect the idle engine', async () => {
    const d = canvas(),
      { a, authority } = await pair(slideEditorCodec, d),
      id = d.slides[0].objects[0].id;
    const engine = a.session.text(id);
    engine.dispatch(engine.state.tr.insertText('確定済み', 1));
    await a.session.flush();
    a.session.execute(deleteObjects(d.slides[0].id, [id]));
    await a.session.flush();
    expect(a.session.error).toBe('');
    expect(a.session.pendingCount).toBe(0);
    expect(() => JSON.stringify(a.session.checkpoint())).not.toThrow();
    const reopened = new SharedEditorSession(slideEditorCodec, a.session.adapter);
    reopened.resume(a.session.checkpoint());
    await reopened.open();
    expect(reopened.error).toBe('');
    authority.compact();
    await a.session.reconnect();
    expect(a.session.error).toBe('');
    await a.session.history('undo');
    expect(engine.conflict).toBe('');
    expect(engine.state.doc.textContent).toBe('確定済みhello');
    engine.dispatch(engine.state.tr.insertText('復元後', 1));
    await a.session.flush();
    expect(a.session.content.slides[0].objects[0].text).toBe('復元後確定済みhello');
    reopened.close();
    a.session.close();
  });
  it('rebases simultaneous canvas input, marks and newline paste without string replacement', async () => {
    const d = canvas(),
      { a, b, authority } = await pair(slideEditorCodec, d),
      id = d.slides[0].objects[0].id;
    const x = a.session.text(id),
      y = b.session.text(id);
    x.dispatch(x.state.tr.insertText('A', 1));
    y.dispatch(y.state.tr.insertText('B', 1));
    await Promise.all([a.session.flush(), b.session.flush()]);
    expect(a.session.content).toEqual(b.session.content);
    expect(authority.snapshot().content.slides[0].objects[0].text).toBe('ABhello');
    y.dispatch(y.state.tr.addMark(1, 3, canvasTextSchema.marks.bold.create()));
    x.dispatch(x.state.tr.insertText('日本語', 3));
    await Promise.all([a.session.flush(), b.session.flush()]);
    expect(a.session.content).toEqual(b.session.content);
    expect(authority.snapshot().content.slides[0].objects[0].text).toContain('日本語');
    expect(authority.snapshot().content.slides[0].objects[0].runs?.some((r) => r.style?.bold)).toBe(
      true,
    );
    a.session.close();
    b.session.close();
  });
  it('independent canvas boxes have independent text versions', async () => {
    let d = canvas();
    d = insertObject(d.slides[0].id, 'text', { text: 'other' }).apply(d);
    const { a, b, authority } = await pair(slideEditorCodec, d);
    const x = a.session.text(d.slides[0].objects[0].id),
      y = b.session.text(d.slides[0].objects[1].id);
    x.dispatch(x.state.tr.insertText('A', 1));
    y.dispatch(y.state.tr.insertText('B', 1));
    await Promise.all([a.session.flush(), b.session.flush()]);
    expect(authority.snapshot().content.slides[0].objects.map((e) => e.text)).toEqual([
      'Ahello',
      'Bother',
    ]);
    expect(a.session.rejected).toHaveLength(0);
    expect(b.session.rejected).toHaveLength(0);
    a.session.close();
    b.session.close();
  });
  it('retains text through lost acknowledgement and reload checkpoint without duplication', async () => {
    const d = canvas(),
      { a, authority } = await pair(slideEditorCodec, d),
      id = d.slides[0].objects[0].id;
    const x = a.session.text(id);
    a.faults.dropAck = true;
    x.dispatch(x.state.tr.insertText('retained', 1));
    await a.session.flush();
    const checkpoint = a.session.checkpoint();
    const restored = new SharedEditorSession(slideEditorCodec, a.session.adapter);
    restored.resume(checkpoint);
    a.faults.dropAck = false;
    await restored.open();
    await restored.flush();
    expect(authority.snapshot().content.slides[0].objects[0].text).toBe('retainedhello');
    expect(restored.content).toEqual(authority.snapshot().content);
    restored.close();
  });
  it('read-only revocation retains unconfirmed text and authority rejects the queued submit', async () => {
    const d = canvas(),
      { a, authority } = await pair(slideEditorCodec, d),
      id = d.slides[0].objects[0].id;
    const x = a.session.text(id);
    a.faults.connected = false;
    x.dispatch(x.state.tr.insertText('private', 1));
    await a.session.flush();
    a.base.setPermissions({ writable: false, scopes: ['*'] });
    a.faults.connected = true;
    await a.session.reconnect();
    expect(authority.snapshot().content.slides[0].objects[0].text).toBe('hello');
    expect(a.session.content.slides[0].objects[0].text).toBe('privatehello');
    expect(a.session.rejected[0].receipt).toMatchObject({
      status: 'rejected',
      code: 'unauthorized',
    });
    expect(a.session.checkpoint().text[0].steps).not.toHaveLength(0);
    expect(() => x.dispatch(x.state.tr.insertText('no', 1))).toThrow('read only');
  });
  it('normal Document engine shares concurrent transactions through the same session and Undo', async () => {
    const { a, b, authority } = await pair(documentCodec, createDocument());
    const x = a.session.text('text'),
      y = b.session.text('text');
    x.dispatch(x.state.tr.insertText('A', 1));
    y.dispatch(y.state.tr.insertText('B', 1));
    await Promise.all([a.session.flush(), b.session.flush()]);
    expect(x.state.doc.textContent).toContain('AB');
    expect(x.state.doc.eq(y.state.doc)).toBe(true);
    expect(a.session.content).toEqual(authority.snapshot().content);
    await a.session.history('undo');
    expect(a.session.lastReceipt).toMatchObject({ status: 'rejected', code: 'undo-conflict' });
    expect(x.state.doc.textContent).toContain('AB');
    a.session.close();
    b.session.close();
  });
  it('explicit cancel discards never-sent text after a remote restore or deletion without changing authority content', async () => {
    for (const deleted of [false, true]) {
      const d = canvas(),
        { a, authority } = await pair(slideEditorCodec, d),
        id = d.slides[0].objects[0].id;
      const engine = a.session.text(id);
      engine.dispatch(engine.state.tr.insertText('private', 1));
      if (deleted)
        authority.commit(
          actor('B'),
          prepareEditorCommand(
            slideEditorCodec,
            authority.snapshot(),
            actor('B'),
            deleteObjects(d.slides[0].id, [id]),
          )!,
        );
      else {
        const restored = structuredClone(d);
        restored.slides[0].objects[0].text = 'restored';
        authority.restore(actor('B'), restored, 0);
      }
      await a.session.flush();
      expect(a.session.pendingCount).toBe(1);
      expect(engine.state.doc.textContent).toContain('private');
      const confirmed = authority.snapshot();
      a.session.discardUnsubmitted();
      expect(a.session.pendingCount).toBe(0);
      expect(a.session.content).toEqual(confirmed.content);
      expect(authority.snapshot()).toEqual(confirmed);
      a.session.close();
    }
  });
});
it('preserves ordered starts through shared text edits, remote changes and selective Undo', async () => {
  const content = {
    schemaVersion: 2 as const,
    blocks: [
      {
        id: 'list',
        type: 'numbered-list' as const,
        start: 7,
        text: 'item',
        items: [{ id: 'item', paragraphId: 'item-p', rich: [{ text: 'item' }] }],
      },
      { id: 'after', type: 'paragraph' as const, text: 'after' },
    ],
  };
  const { a, b, authority } = await pair(documentCodec, content);
  const x = a.session.text('text'),
    y = b.session.text('text');
  x.dispatch(x.state.tr.insertText('A', 3));
  await a.session.flush();
  const after = y.state.doc.child(0).nodeSize + 1;
  y.dispatch(y.state.tr.insertText('B', after));
  await b.session.flush();
  expect(authority.snapshot().content.blocks[0].start).toBe(7);
  await a.session.history('undo');
  expect(authority.snapshot().content.blocks[0].text).toBe('item');
  expect(authority.snapshot().content.blocks[1].text).toBe('Bafter');
  expect(authority.snapshot().content.blocks[0].start).toBe(7);
  await a.session.history('redo');
  expect(authority.snapshot().content.blocks[0].start).toBe(7);
  a.session.close();
  b.session.close();
});
