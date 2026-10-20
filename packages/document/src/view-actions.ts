import { flushSync } from 'react-dom';
import { TextSelection, NodeSelection, type Transaction, type Command } from 'prosemirror-state';
import { type EditorView } from 'prosemirror-view';
import { toggleMark, lift } from 'prosemirror-commands';
import { sinkListItem, liftListItem, wrapInList } from 'prosemirror-schema-list';
import { type EditorCommand } from '@editor-platform/editor-core';
import { readImage } from '@editor-platform/canvas-ui';
import {
  documentSchema,
  activeDocumentLink,
  setDocumentLink,
  blockNode,
  activeBlock,
  jumpToBlock,
  formatBlock,
} from './engine';
import { makeBlock, type BlockType, type DocumentBlock, type DocumentContent } from './model';
import { topLevelBlockPosition, type DocumentCallbacks } from './view-model';

export interface DocumentActionContext {
  view: { current: EditorView | null };
  callbacks: { current: DocumentCallbacks };
  readOnly: boolean;
  selectedId?: string;
  selected?: DocumentBlock;
  execute: (command: EditorCommand<DocumentContent>) => void;
  setError: (message: string) => void;
  setInsertOpen: (open: boolean) => void;
  setLink: (href: string) => void;
  setLinkOpen: (open: boolean) => void;
}

function run(ctx: DocumentActionContext, cmd: Command) {
  const editor = ctx.view.current;
  if (!editor || ctx.readOnly) return;
  cmd(editor.state, (tr) => editor.dispatch(tr.setMeta('explicit', true)), editor);
  editor.focus();
}

function dispatch(ctx: DocumentActionContext, tr: Transaction) {
  if (!ctx.readOnly) ctx.view.current?.dispatch(tr.setMeta('explicit', true));
}

function insert(ctx: DocumentActionContext, type: BlockType, patch: Partial<DocumentBlock> = {}) {
  const editor = ctx.view.current;
  if (!editor || ctx.callbacks.current.readOnly) return;
  const b = { ...makeBlock(type), ...patch };
  const $from = editor.state.selection.$from;
  const pos = $from.depth ? $from.after(1) : editor.state.selection.to;
  const node = blockNode(b);
  const tr = editor.state.tr.insert(pos, node);
  dispatch(
    ctx,
    tr
      .setSelection(
        node.isAtom
          ? NodeSelection.create(tr.doc, pos)
          : TextSelection.near(tr.doc.resolve(pos + 1)),
      )
      .scrollIntoView(),
  );
  editor.focus();
  ctx.setInsertOpen(false);
}

async function imageFile(ctx: DocumentActionContext, file: File) {
  try {
    const src = await readImage(file);
    const image = new Image();
    image.src = src;
    await image.decode();
    insert(ctx, 'image', { src, alt: file.name, width: Math.min(600, image.width) });
  } catch (e) {
    ctx.setError((e as Error).message);
  }
}

function blockPosition(ctx: DocumentActionContext, id: string) {
  return topLevelBlockPosition(ctx.view.current?.state, id);
}

function patchBlock(ctx: DocumentActionContext, patch: Partial<DocumentBlock>) {
  const { selected, view } = ctx;
  if (!selected || !view.current || ctx.readOnly) return;
  const pos = blockPosition(ctx, selected.id);
  if (pos === undefined) return;
  const node = blockNode({ ...selected, ...patch });
  dispatch(
    ctx,
    view.current.state.tr.replaceWith(
      pos,
      pos + view.current.state.doc.nodeAt(pos)!.nodeSize,
      node,
    ),
  );
}

function move(ctx: DocumentActionContext, delta: number) {
  const editor = ctx.view.current;
  const latest = ctx.callbacks.current;
  if (!editor || latest.readOnly) return;
  const id = activeBlock(editor.state)?.id ?? ctx.selectedId,
    index = latest.content.blocks.findIndex((b) => b.id === id),
    target = index + delta;
  if (index < 0 || target < 0 || target >= latest.content.blocks.length) return;
  const from = blockPosition(ctx, id!),
    node = editor.state.doc.nodeAt(from!)!;
  let to = blockPosition(ctx, latest.content.blocks[target].id)!;
  if (delta > 0) to += editor.state.doc.nodeAt(to)!.nodeSize;
  const tr = editor.state.tr.delete(from!, from! + node.nodeSize);
  tr.insert(tr.mapping.map(to), node);
  dispatch(ctx, tr);
}

function remove(ctx: DocumentActionContext) {
  const { selected, view } = ctx;
  if (!selected || !view.current) return;
  const pos = blockPosition(ctx, selected.id)!;
  dispatch(
    ctx,
    view.current.state.tr.delete(pos, pos + view.current.state.doc.nodeAt(pos)!.nodeSize),
  );
}

function openLink(ctx: DocumentActionContext) {
  const editor = ctx.view.current;
  if (!editor || ctx.callbacks.current.readOnly) return;
  ctx.setLink(activeDocumentLink(editor.state)?.href ?? 'https://');
  ctx.setLinkOpen(true);
}

function closeLink(ctx: DocumentActionContext) {
  // Unmount the modal and finish its generic focus cleanup before restoring
  // ProseMirror's caret/stored marks; the editor is inert while it stays open.
  flushSync(() => ctx.setLinkOpen(false));
  ctx.view.current?.focus();
}

function pageSetting(
  ctx: DocumentActionContext,
  patch: Partial<NonNullable<DocumentContent['page']>>,
) {
  if (ctx.readOnly) return;
  ctx.execute({
    type: 'document.page',
    label: 'Page setup',
    apply: (d) => ({ ...d, page: { size: 'A4', margin: 64, ...d.page, ...patch } }),
  });
}

function checklist(ctx: DocumentActionContext) {
  run(ctx, wrapInList(documentSchema.nodes.bullet_list, { check: true }));
  const editor = ctx.view.current;
  if (editor) {
    const tr = editor.state.tr;
    editor.state.doc.nodesBetween(
      editor.state.selection.from,
      editor.state.selection.to,
      (n, p) => {
        if (n.type.name === 'list_item')
          tr.setNodeMarkup(p, undefined, { ...n.attrs, checked: false });
      },
    );
    dispatch(ctx, tr);
  }
}

function navigate(ctx: DocumentActionContext, blockId: string) {
  const editor = ctx.view.current;
  if (!editor) return;
  const transaction = jumpToBlock(editor.state, blockId);
  editor.focus();
  if (transaction) editor.dispatch(transaction);
}

/** Binds the editing actions of one render to that render's props and state. */
export function documentActions(ctx: DocumentActionContext) {
  const mark = (name: string, attrs?: Record<string, string>) =>
    run(ctx, toggleMark(documentSchema.marks[name], attrs));
  return {
    run: (cmd: Command) => run(ctx, cmd),
    dispatch: (tr: Transaction) => dispatch(ctx, tr),
    insert: (type: BlockType, patch?: Partial<DocumentBlock>) => insert(ctx, type, patch),
    imageFile: (file: File) => imageFile(ctx, file),
    patchBlock: (patch: Partial<DocumentBlock>) => patchBlock(ctx, patch),
    move: (delta: number) => move(ctx, delta),
    remove: () => remove(ctx),
    mark,
    openLink: () => openLink(ctx),
    closeLink: () => closeLink(ctx),
    pageSetting: (patch: Partial<NonNullable<DocumentContent['page']>>) => pageSetting(ctx, patch),
    textStyle: (value: string) => {
      const [type, l] = value.split('-');
      run(ctx, (state, dispatch) => formatBlock(state, dispatch, type, Number(l) || 1));
    },
    bulletList: () => run(ctx, wrapInList(documentSchema.nodes.bullet_list)),
    orderedList: () => run(ctx, wrapInList(documentSchema.nodes.ordered_list)),
    checklist: () => checklist(ctx),
    indent: () => run(ctx, sinkListItem(documentSchema.nodes.list_item)),
    outdent: () =>
      run(ctx, (s, d, v) => liftListItem(documentSchema.nodes.list_item)(s, d, v) || lift(s, d, v)),
    setLink: (href: string | null) => {
      run(ctx, setDocumentLink(href));
      closeLink(ctx);
    },
    navigate: (blockId: string) => navigate(ctx, blockId),
  };
}

export type DocumentActions = ReturnType<typeof documentActions>;
