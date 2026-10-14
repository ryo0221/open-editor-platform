import { expect, it } from 'vitest';
import {
  Authority,
  initial,
  localAdapter,
  saveConfirmedVersion,
  type ConfirmedVersion,
  type Principal,
} from '@editor-platform/collaboration-core';
import type { DocumentContent } from '@editor-platform/document/model';
import { documentEditorCodec } from './document-editor';
import { SharedEditorSession, type EditorHostAdapter } from './editor-session';

const actor: Principal = {
  actorId: 'A',
  clientId: 'a',
  sessionId: 'one',
  writable: true,
  scopes: ['*'],
};
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.each(['receipt-first', 'event-first'] as const)(
  'rebases text submitted during held attribute Undo, %s, and drains history before saving',
  async (delivery) => {
    const content: DocumentContent = {
      schemaVersion: 2,
      blocks: [
        { id: 'body', type: 'paragraph', text: '案件本文' },
        { id: 'component', type: 'paragraph', text: '注意書き' },
      ],
    };
    const codec = documentEditorCodec;
    const authority = new Authority(codec, initial('text-recovery', codec, content));
    const versions: ConfirmedVersion<DocumentContent>[] = [];
    const heldUndo = gate(),
      undoEntered = gate(),
      submitted = gate(),
      heldReceipt = gate();
    const receipts: { status: string; code?: string }[] = [];
    let missOneSync = false,
      pendingBody = false;
    const adapter = {
      ...localAdapter(authority, actor),
      // Match a pull transport, so the inverse is not pushed before the queued edit.
      subscribe: () => () => {},
      versions: async () => versions,
      changes: async (after: number) => {
        if (missOneSync) {
          missOneSync = false;
          return { events: [] };
        }
        return authority.changes(after);
      },
      submit: async (op) => {
        const receipt = authority.commit(actor, op);
        receipts.push(receipt);
        if (pendingBody && receipt.status === 'accepted') {
          submitted.release();
          if (delivery === 'event-first') await heldReceipt.promise;
        }
        return receipt;
      },
      undo: async (id, redo) => {
        const receipt = authority.undo(actor, id, redo);
        undoEntered.release();
        await heldUndo.promise;
        return receipt;
      },
      save: async (reason) => {
        const version = await saveConfirmedVersion(authority, actor.actorId, reason);
        versions.push(version);
        return version;
      },
      restore: async (id, revision) =>
        authority.restore(
          actor,
          versions.find((v) => v.version.versionId === id)!.version.content,
          revision,
        ),
      registerProposal: async (p) => authority.register(p),
      previewProposal: async (id) => authority.preview(actor, id),
      applyProposal: async (id, token) => authority.applyProposal(actor, id, token),
      cancelProposal: async (id, reject) => {
        const proposal = authority.cancelProposal(id, reject);
        if (!proposal) throw Error('Unknown proposal');
        return proposal;
      },
    } satisfies EditorHostAdapter<DocumentContent>;
    const session = new SharedEditorSession(codec, adapter);
    await session.open();
    const engine = session.text('text');
    const style = session.actions([
      {
        type: 'document.attributes',
        target: 'text',
        payload: {
          patches: [{ id: 'component', values: { style: { color: '#2255aa' } } }],
        },
      },
    ]);
    await session.flush();
    expect(session.pendingCount).toBe(0);
    receipts.splice(0);
    pendingBody = true;
    const undo = session.history('undo');
    await undoEntered.promise;
    missOneSync = true;
    engine.dispatch(engine.state.tr.insertText('追記', 1));
    const flushing = session.flush();
    await submitted.promise;
    if (delivery === 'event-first') await session.sync();
    heldReceipt.release();
    await flushing;
    heldUndo.release();
    await undo;
    expect(receipts).toMatchObject([
      { status: 'rejected', code: 'resync-required' },
      { status: 'accepted' },
    ]);
    expect(session.pendingCount).toBe(0);
    expect(session.content.blocks[0].text).toBe('追記案件本文');
    expect(session.content.blocks[1].style).toBeUndefined();
    expect(session.checkpoint().undoIds).not.toContain(style.operationId);
    expect(session.canRedo).toBe(false);
    await session.history('undo');
    expect(session.content.blocks[0].text).toBe('案件本文');
    await session.history('redo');
    expect(session.content.blocks[0].text).toBe('追記案件本文');
    expect(session.pendingCount).toBe(0);
    expect((await session.save('After rebase and Undo')).version.content).toEqual(session.content);
    session.close();
  },
);
