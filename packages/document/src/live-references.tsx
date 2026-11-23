import { useEffect, useMemo, useState, type RefObject } from 'react';
import { canonicalJson, newId } from '@editor-platform/artifact-core';
import { type LiveReference } from '@editor-platform/artifact-references';
import {
  LiveReferenceTools,
  type LiveReferenceConnection,
  type LiveReviewItem,
} from '@editor-platform/artifact-references/react';
import type { Node } from 'prosemirror-model';
import {
  NodeSelection,
  TextSelection,
  type EditorState,
  type Transaction,
} from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { blockNode, documentSchema } from './engine';
import { makeBlock } from './model';

type DocumentCitation = LiveReviewItem & { pos: number; node: Node };

export function documentCitations(doc?: Node): DocumentCitation[] {
  const items: DocumentCitation[] = [];
  doc?.descendants((node, pos) => {
    const quote = node.type === documentSchema.nodes.live_quote;
    const figure = node.type === documentSchema.nodes.embedded && node.attrs.block.liveFigure;
    if (!quote && !figure) return;
    const parent = doc.resolve(pos).node(1);
    items.push({
      id: node.attrs.id,
      node,
      pos,
      reference: figure || node.attrs.reference,
      location: parent?.textContent.slice(0, 40) || `本文 ${doc.resolve(pos).index(0) + 1}`,
    });
  });
  return items;
}

function captureSelection(editor: EditorView) {
  const { doc, selection } = editor.state;
  if (!editor.hasFocus() || selection instanceof NodeSelection) return selection;
  const visible = editor.dom.ownerDocument.getSelection();
  if (
    !visible?.anchorNode ||
    !visible.focusNode ||
    !editor.dom.contains(visible.anchorNode) ||
    !editor.dom.contains(visible.focusNode)
  )
    return selection;
  const anchor = editor.posAtDOM(visible.anchorNode, visible.anchorOffset);
  const head = editor.posAtDOM(visible.focusNode, visible.focusOffset);
  if (anchor === selection.anchor && head === selection.head) return selection;
  const actual = TextSelection.between(doc.resolve(anchor), doc.resolve(head));
  editor.dispatch(editor.state.tr.setSelection(actual));
  return editor.state.selection;
}

function applyCitation(editor: EditorView, tr: Transaction) {
  const result: { applied?: true; error?: string } = {};
  editor.dispatch(tr.setMeta('explicit', true).setMeta('liveReference', result).scrollIntoView());
  if (!result.applied)
    throw new Error(result.error || '引用を確定できませんでした。状態を確認してください。');
}

export function DocumentLiveReferences({
  state,
  view,
  connection,
  readOnly,
  shared,
  active,
  onProposal,
}: {
  state: EditorState | null;
  view: RefObject<EditorView | null>;
  connection?: LiveReferenceConnection;
  readOnly: boolean;
  shared: boolean;
  active: boolean;
  onProposal?(editor: EditorView, tr: Transaction, label: string): void;
}) {
  const doc = state?.doc;
  const items = useMemo(() => documentCitations(doc), [doc]);
  const [newer, setNewer] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const editor = view.current;
    if (!editor || !connection) return;
    const decorations = (current: EditorState) =>
      DecorationSet.create(
        current.doc,
        documentCitations(current.doc)
          .filter(({ id }) => newer.has(id))
          .map(({ pos, node }) =>
            Decoration.widget(
              pos + node.nodeSize,
              () => {
                const badge = document.createElement('span');
                badge.className = 'ep-live-badge';
                badge.textContent = '新しい版があります';
                return badge;
              },
              { side: -1, key: `newer:${pos}` },
            ),
          ),
      );
    // A plugin-free decoration provider keeps the newer status out of the native document.
    const previous = editor.props.decorations;
    editor.setProps({
      decorations: (current) => {
        const base = previous?.(current);
        const badges = decorations(current);
        // DecorationSource is public, while DecorationGroup is internal to ProseMirror.
        return base instanceof DecorationSet ? base.add(current.doc, badges.find()) : badges;
      },
    });
    return () => {
      if (view.current === editor) editor.setProps({ decorations: previous });
    };
  }, [view, connection, newer]);
  const selected =
    state?.selection instanceof NodeSelection
      ? items.find(({ pos }) => pos === state.selection.from)
      : undefined;

  if (!active) return null;
  return (
    <LiveReferenceTools
      connection={connection}
      items={items}
      selected={selected}
      onNewer={setNewer}
      readOnly={readOnly}
      canPropose={!!onProposal}
      disabledReason={shared ? '共有編集中は引用を編集できません。' : undefined}
      captureInsert={() => {
        const editor = view.current;
        if (!editor) throw new Error('文書の挿入位置を選んでください。');
        const selection = captureSelection(editor);
        const basis = editor.state.doc;
        return (reference, propose) => {
          if (
            view.current !== editor ||
            editor.state.doc !== basis ||
            !editor.state.selection.eq(selection)
          )
            throw new Error('挿入位置が変わりました。もう一度選んでください。');
          const tr = editor.state.tr;
          const $pos = selection.$from;
          if (reference.presentation.kind === 'value') {
            if (
              !(selection instanceof TextSelection) ||
              !$pos.parent.inlineContent ||
              !$pos.sameParent(selection.$to) ||
              $pos.parent.type.spec.code
            )
              throw new Error('本文内の文字の挿入位置を選んでください。');
            const at = selection.to;
            const node = documentSchema.nodes.live_quote.create({ id: newId('quote'), reference });
            tr.insert(at, node);
            if (tr.doc.nodeAt(at)?.attrs.id !== node.attrs.id)
              throw new Error('この位置には値の引用を挿入できません。');
            tr.setSelection(NodeSelection.create(tr.doc, at));
          } else {
            const at = $pos.depth ? $pos.after(1) : selection.to;
            const block = { ...makeBlock('image'), liveFigure: reference };
            tr.insert(at, blockNode(block));
            tr.setSelection(NodeSelection.create(tr.doc, at));
          }
          if (propose) {
            if (!onProposal) throw new Error('引用を提案できません。');
            onProposal(editor, tr, '引用を挿入');
          } else applyCitation(editor, tr);
        };
      }}
      change={(expected, replacement?: LiveReference, propose?: boolean) => {
        const editor = view.current;
        const found = documentCitations(editor?.state.doc).filter(({ id }) => id === expected.id);
        const [current] = found;
        if (
          !editor ||
          found.length !== 1 ||
          canonicalJson(current.reference) !== canonicalJson(expected.reference)
        )
          throw new Error('対象引用が変わりました。もう一度確認してください。');
        const { pos, node } = current;
        const tr = editor.state.tr;
        if (!replacement) tr.delete(pos, pos + node.nodeSize);
        else
          tr.setNodeMarkup(
            pos,
            undefined,
            node.type === documentSchema.nodes.live_quote
              ? { ...node.attrs, reference: replacement }
              : { ...node.attrs, block: { ...node.attrs.block, liveFigure: replacement } },
          );
        if (propose) {
          if (!onProposal) throw new Error('引用を提案できません。');
          onProposal(editor, tr, replacement ? '引用を更新' : '引用を外す');
        } else applyCitation(editor, tr);
      }}
    />
  );
}
