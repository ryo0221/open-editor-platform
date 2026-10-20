import { useEffect, type RefObject } from 'react';
import { type Root } from 'react-dom/client';
import { EditorState, NodeSelection, type Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { newId } from '@editor-platform/artifact-core';
import { documentPlugins, contentToNode, activeTextRange } from './engine';
import { type createLocalDocumentCommand } from './local-engine-command';
import { type DocumentBlock, type DocumentContent } from './model';
import { textBlockView } from './text-block-view';
import { type DocumentActions } from './view-actions';
import {
  documentDecorations,
  firstImageFile,
  isTypingTransaction,
  type DocumentCallbacks,
  type DocumentTextBridge,
} from './view-model';
import { embeddedNodeView, listItemNodeView } from './view-node-views';

export interface TypingGroup {
  key: string;
  time: number;
  position: number;
}

export type EmittedProjection = {
  blocks?: DocumentBlock[];
  key?: string;
  content?: DocumentContent;
} | null;

type LocalDocumentCommand = ReturnType<typeof createLocalDocumentCommand>;

export interface DocumentEditorContext {
  mount: RefObject<HTMLDivElement | null>;
  view: { current: EditorView | null };
  callbacks: { current: DocumentCallbacks };
  embeddedViews: { current: Set<() => void> };
  typing: { current: TypingGroup };
  emitted: { current: EmittedProjection };
  localDocumentCommand: LocalDocumentCommand;
  setEngineState: (state: EditorState) => void;
  setError: (message: string) => void;
  setFindOpen: (open: boolean) => void;
  setInsertOpen: (open: boolean) => void;
  actions: Pick<DocumentActions, 'imageFile' | 'move' | 'openLink'>;
  textEngine?: DocumentTextBridge;
}

function localUpdate(
  ctx: DocumentEditorContext,
  tr: Transaction,
  doc: EditorState['doc'],
  previousPosition: number,
) {
  const typing = ctx.typing.current;
  const now = Date.now(),
    isTyping = isTypingTransaction(tr);
  if (!isTyping || now - typing.time > 800 || previousPosition !== typing.position)
    typing.key = newId('typing');
  const update = ctx.localDocumentCommand(ctx.callbacks.current.content, doc, {
    origin: 'local',
    transactionId: newId('transaction'),
    ...(isTyping ? { mergeKey: typing.key } : {}),
  });
  return { update, updateTime: now };
}

function selectApplied(callbacks: DocumentCallbacks, state: EditorState) {
  const block = activeTextRange(state);
  if (block)
    callbacks.select(block.id, {
      type: 'text',
      start: block.start,
      end: block.end,
    });
  else if (state.selection instanceof NodeSelection) {
    const id = state.selection.node.attrs.id;
    if (id) callbacks.select(id);
  }
}

function applyTransaction(ctx: DocumentEditorContext, editor: EditorView, tr: Transaction) {
  const previousPosition = editor.state.selection.from;
  const bridge = ctx.callbacks.current.textEngine;
  const applied = bridge
    ? (bridge.dispatch(tr), { state: bridge.state, transactions: [] })
    : editor.state.applyTransaction(tr);
  let local: ReturnType<typeof localUpdate> | undefined;
  if (applied.transactions.some((t) => t.docChanged))
    local = localUpdate(ctx, tr, applied.state.doc, previousPosition);
  else if (tr.selectionSet) {
    ctx.typing.current.key = newId('typing');
    ctx.typing.current.position = tr.selection.from;
  }
  // Projection/reference validation above completes before any editor/native mutation.
  editor.updateState(applied.state);
  ctx.setEngineState(applied.state);
  if (local) {
    const { update, updateTime } = local;
    ctx.emitted.current = { blocks: update.content.blocks, content: update.content };
    ctx.callbacks.current.content = update.content;
    ctx.callbacks.current.execute(update.command);
    ctx.typing.current.time = updateTime;
    ctx.typing.current.position = tr.selection.from;
    ctx.setError('');
  }
  selectApplied(ctx.callbacks.current, applied.state);
}

function dispatchTransaction(ctx: DocumentEditorContext, editor: EditorView, tr: Transaction) {
  if (ctx.callbacks.current.readOnly && (tr.docChanged || tr.storedMarksSet)) return;
  try {
    applyTransaction(ctx, editor, tr);
  } catch (e) {
    ctx.setError((e as Error).message);
  }
}

function insertDroppedImage(ctx: DocumentEditorContext, files: FileList | undefined | null) {
  const file = firstImageFile(files);
  if (!file || ctx.callbacks.current.readOnly) return false;
  void ctx.actions.imageFile(file);
  return true;
}

function isGuardedKey(editor: EditorView, event: KeyboardEvent) {
  return (
    event.isComposing ||
    editor.composing ||
    (event.target instanceof Element && !!event.target.closest('input,textarea,select'))
  );
}

function isModifiedKey(event: KeyboardEvent) {
  return (event.ctrlKey || event.metaKey) && !event.altKey;
}

function isHistoryShortcut(callbacks: DocumentCallbacks, event: KeyboardEvent) {
  return (
    !callbacks.readOnly &&
    !!(callbacks.textEngine || callbacks.history) &&
    isModifiedKey(event) &&
    ['z', 'y'].includes(event.key.toLowerCase())
  );
}

function runHistoryShortcut(ctx: DocumentEditorContext, event: KeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
  ctx.typing.current = { key: newId('typing'), time: 0, position: -1 };
  const direction = event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo';
  try {
    const { textEngine, history } = ctx.callbacks.current;
    if (textEngine) textEngine.history(direction);
    else history?.[direction]();
  } catch (error) {
    ctx.setError((error as Error).message);
  }
}

function isLinkShortcut(callbacks: DocumentCallbacks, event: KeyboardEvent) {
  return !callbacks.readOnly && isModifiedKey(event) && event.key.toLowerCase() === 'k';
}

/** Runs the editor shortcut for this key, returning whether it was handled. */
function editorShortcut(ctx: DocumentEditorContext, editor: EditorView, event: KeyboardEvent) {
  if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault();
    ctx.actions.move(event.key === 'ArrowUp' ? -1 : 1);
    return true;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
    event.preventDefault();
    ctx.setFindOpen(true);
    return true;
  }
  if (event.key === '/' && editor.state.selection.$from.parent.textContent === '') {
    event.preventDefault();
    ctx.setInsertOpen(true);
    return true;
  }
  return false;
}

function handleKeyDown(ctx: DocumentEditorContext, editor: EditorView, event: KeyboardEvent) {
  if (isGuardedKey(editor, event)) return false;
  if (isHistoryShortcut(ctx.callbacks.current, event)) {
    runHistoryShortcut(ctx, event);
    return true;
  }
  if (isLinkShortcut(ctx.callbacks.current, event)) {
    event.preventDefault();
    ctx.actions.openLink();
    return true;
  }
  return editorShortcut(ctx, editor, event);
}

function createDocumentEditor(ctx: DocumentEditorContext, mount: HTMLDivElement, roots: Set<Root>) {
  const { callbacks, textEngine } = ctx;
  const editor: EditorView = new EditorView(mount, {
    decorations: (state) =>
      documentDecorations(state, callbacks.current.content, callbacks.current.annotations),
    state:
      textEngine?.state ??
      EditorState.create({
        doc: contentToNode(callbacks.current.content),
        plugins: documentPlugins(),
      }),
    attributes: {
      role: 'textbox',
      'aria-label': 'Document body',
      'aria-multiline': 'true',
      'aria-readonly': String(callbacks.current.readOnly),
      spellcheck: 'true',
    },
    editable: () => !callbacks.current.readOnly,
    nodeViews: {
      paragraph: textBlockView,
      heading: textBlockView,
      embedded: (node) =>
        embeddedNodeView(node, { callbacks, embeddedViews: ctx.embeddedViews, roots }),
      list_item: (node, view, getPos) => listItemNodeView(node, view, getPos, callbacks),
    },
    dispatchTransaction: (tr) => dispatchTransaction(ctx, editor, tr),
    handlePaste: (_view, event) => insertDroppedImage(ctx, event.clipboardData?.files),
    handleDrop: (_view, event) => insertDroppedImage(ctx, event.dataTransfer?.files),
    handleKeyDown: (view, event) => handleKeyDown(ctx, view, event),
  });
  return editor;
}

/** Creates the ProseMirror view once, with the actions and text engine of the first render. */
export function useDocumentEditorView(ctx: DocumentEditorContext) {
  useEffect(() => {
    if (!ctx.mount.current) return;
    const roots = new Set<Root>();
    const textEngine = ctx.textEngine;
    const editor = createDocumentEditor(ctx, ctx.mount.current, roots);
    ctx.view.current = editor;
    ctx.setEngineState(editor.state);
    const stop = textEngine?.subscribe(() => {
      if (ctx.view.current && ctx.view.current.state !== textEngine.state) {
        ctx.view.current.updateState(textEngine.state);
        ctx.setEngineState(textEngine.state);
      }
    });
    return () => {
      stop?.();
      ctx.view.current = null;
      editor.destroy();
      roots.forEach((root) => queueMicrotask(() => root.unmount()));
    };
  }, []);
}
