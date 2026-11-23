import { newId } from '@editor-platform/artifact-core';
import { immutableCommand, type EditorCommand } from '@editor-platform/editor-core';
import { validLiveReference, type LiveReference } from '@editor-platform/artifact-references';
import type { Node as PMNode } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import {
  blockNode,
  contentToNode,
  documentSchema,
  documentTextPosition,
  nodeToContent,
} from './engine';
import { isDocument, makeBlock, type DocumentContent } from './model';

/**
 * Where a headless citation goes (finding 79, for a Host's worker tool): a value at a text
 * offset of a paragraph or heading (also one inside a list or table, by its ID), or a figure as
 * a new block after a top-level block.
 */
export type DocumentCitationPlace =
  | { kind: 'text'; blockId: string; offset: number }
  | { kind: 'after'; blockId: string };

function onlyTextBlock(doc: PMNode, id: string) {
  const found: { node: PMNode; pos: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.attrs.id === id && node.inlineContent) found.push({ node, pos });
  });
  return found.length === 1 ? found[0] : undefined;
}

/**
 * Insert a fixed citation without an editor view, through the same ProseMirror projection the
 * editor uses, so it is stored packed in `liveSnapshots` like an interactive insert. The
 * reference must come from `prepareLiveReference` (the Host has checked access and the version).
 */
export function insertDocumentCitation(
  place: DocumentCitationPlace,
  reference: LiveReference,
  id: string = newId(reference.presentation.kind === 'value' ? 'quote' : 'block'),
): EditorCommand<DocumentContent> {
  return immutableCommand('document.insert-citation', '引用を挿入', (content: DocumentContent) => {
    if (!validLiveReference(reference) || reference.schemaVersion !== 3)
      throw new Error('引用が不正です。');
    const doc = contentToNode(content);
    const tr = new Transform(doc);
    if (reference.presentation.kind === 'value') {
      if (place.kind !== 'text') throw new Error('値の引用は本文の文字の位置に挿入します。');
      const target = onlyTextBlock(doc, place.blockId);
      if (!target || target.node.type.spec.code)
        throw new Error('本文内の文字の挿入位置が見つかりません。');
      if (!Number.isSafeInteger(place.offset) || place.offset < 0)
        throw new Error('挿入位置が不正です。');
      const at = target.pos + 1 + documentTextPosition(target.node, place.offset);
      tr.insert(at, documentSchema.nodes.live_quote.create({ id, reference }));
      if (tr.doc.nodeAt(at)?.attrs.id !== id)
        throw new Error('この位置には値の引用を挿入できません。');
    } else {
      if (place.kind !== 'after') throw new Error('図の引用は段落のあとに挿入します。');
      let at: number | undefined;
      doc.forEach((node, offset) => {
        if (node.attrs.id === place.blockId) at = offset + node.nodeSize;
      });
      if (at === undefined) throw new Error('挿入位置の段落が見つかりません。');
      tr.insert(at, blockNode({ ...makeBlock('image'), id, liveFigure: reference }));
    }
    tr.doc.check();
    const next = nodeToContent(tr.doc, content);
    if (!isDocument(next)) throw new Error('引用が不正か、件数または容量の上限を超えています。');
    return next;
  });
}
