import { describe, expect, it } from 'vitest';
import {
  Authority,
  initial,
  type Action,
  type Principal,
} from '@editor-platform/collaboration-core';
import {
  addMindmapNode,
  createMindmap,
  deleteMindmapNode,
  moveMindmapNode,
  noteMindmapNode,
  renameMindmapNode,
  type MindmapContent,
} from '@editor-platform/mindmap-core';
import { editorAssetCodec, mindmapEditorCodec, prepareEditorCommand } from './index';

const codec = editorAssetCodec(mindmapEditorCodec);

const first = 'n-' + '1'.repeat(32);
const second = 'n-' + '2'.repeat(32);
const principal = (id: string): Principal => ({
  actorId: id,
  clientId: id,
  sessionId: id,
  writable: true,
  scopes: ['*'],
});
const a = principal('a'),
  b = principal('b');

function fixture() {
  const empty = createMindmap();
  const content = addMindmapNode(empty.rootId, 1, second, 'Second', 'right').apply(
    addMindmapNode(empty.rootId, 0, first, 'First', 'left').apply(empty),
  );
  const snapshot = initial('mindmap', codec, content);
  return { content, snapshot, authority: new Authority(codec, snapshot) };
}

describe('Mind Map through the shared editor command and authority', () => {
  it('combines independent edits and preserves a peer’s change through Undo and Redo', () => {
    const { authority, snapshot } = fixture();
    const rename = prepareEditorCommand(codec, snapshot, a, renameMindmapNode(first, 'Renamed'))!;
    const note = prepareEditorCommand(codec, snapshot, b, noteMindmapNode(second, 'Peer'))!;
    expect(authority.submit(a, rename).status).toBe('accepted');
    expect(authority.submit(b, note).status).toBe('accepted');
    const undone = authority.undo(a, rename.operationId);
    expect(undone.status).toBe('accepted');
    expect(authority.snapshot().content.nodes[first].text).toBe('First');
    expect(authority.snapshot().content.nodes[second].note).toBe('Peer');
    expect(authority.undo(a, undone.operationId, true).status).toBe('accepted');
    expect(authority.snapshot().content.nodes[first].text).toBe('Renamed');
  });

  it('refuses concurrent edits to the same field and deletion of a branch edited by a peer', () => {
    const { authority, snapshot } = fixture();
    const rename = (actor: Principal, text: string) =>
      prepareEditorCommand(codec, snapshot, actor, renameMindmapNode(first, text))!;
    const remove = prepareEditorCommand(codec, snapshot, b, deleteMindmapNode(first))!;
    expect(authority.submit(a, rename(a, 'A')).status).toBe('accepted');
    expect(authority.submit(b, rename(b, 'B'))).toMatchObject({
      status: 'rejected',
      code: 'stale-precondition',
    });
    expect(authority.submit(b, remove)).toMatchObject({
      status: 'rejected',
      code: 'stale-precondition',
    });
    expect(authority.snapshot().revision).toBe(1);
  });

  it('moves a branch atomically and requires grants for the moved branch and parents', () => {
    const { authority, snapshot, content } = fixture();
    const move = prepareEditorCommand(codec, snapshot, a, moveMindmapNode(first, second, 0))!;
    expect(move.targets.sort()).toEqual([first, second, content.rootId].sort());
    expect(authority.submit({ ...a, scopes: [second, content.rootId] }, move)).toMatchObject({
      status: 'rejected',
      code: 'unauthorized',
    });
    const allowed = prepareEditorCommand(codec, snapshot, a, moveMindmapNode(first, second, 0))!;
    expect(authority.submit(a, allowed).status).toBe('accepted');
    expect(authority.snapshot().content.nodes[second].children).toEqual([first]);
    expect(authority.undo(a, allowed.operationId).status).toBe('accepted');
    expect(authority.snapshot().content).toEqual(content);
  });

  it('rejects invalid trees and orphaned selections cannot attach to a replacement', () => {
    const { authority, content, snapshot } = fixture();
    const invalid: Action = {
      type: 'mindmap.edit',
      target: '*',
      payload: {
        changes: [{ kind: 'field', id: first, field: 'children', value: [content.rootId] }],
      },
    };
    expect(() => codec.apply(content, invalid, 0)).toThrow(/valid Mind Map tree/);
    expect(codec.validateAnchor(content, { type: 'element', elementId: first })).toBe(true);
    const remove = prepareEditorCommand(codec, snapshot, a, deleteMindmapNode(first))!;
    expect(authority.submit(a, remove).status).toBe('accepted');
    const after: MindmapContent = authority.snapshot().content;
    expect(
      codec.mapAnchor!({ type: 'element', elementId: first }, content, remove.actions[0], after),
    ).toEqual({
      type: 'element',
      elementId: first,
      orphan: true,
    });
  });
});
