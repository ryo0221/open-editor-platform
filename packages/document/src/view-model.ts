import { EditorState, type Command, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import {
  addColumnAfter,
  deleteColumn,
  deleteRow,
  mergeCells,
  splitCell,
  toggleHeaderRow,
  deleteTable,
} from 'prosemirror-tables';
import {
  type Annotation,
  type EditorCommand,
  type EditorInputs,
  type Region,
} from '@editor-platform/editor-core';
import { type ReferenceSurfaceProps } from '@editor-platform/artifact-references/react';
import { documentSchema, addTableRowAndSelect, nodeToContent } from './engine';
import {
  resolveDocumentAddress,
  type BlockType,
  type DocumentBlock,
  type DocumentContent,
} from './model';

export const blockLabels: Record<BlockType, string> = {
  heading: 'Heading',
  paragraph: 'Paragraph',
  'bulleted-list': 'Bulleted list',
  'numbered-list': 'Numbered list',
  'check-list': 'Checklist',
  table: 'Table',
  code: 'Code',
  image: 'Image',
  mermaid: 'Mermaid',
  html: 'HTML preview',
  'react-preview': 'React adapter',
};

export const documentTableActions: [string, Command][] = [
  ['Add table row', addTableRowAndSelect],
  ['Add table column', addColumnAfter],
  ['Remove table row', deleteRow],
  ['Remove table column', deleteColumn],
  ['Merge cells', mergeCells],
  ['Split cell', splitCell],
  ['Toggle table header', toggleHeaderRow],
  ['Delete table', deleteTable],
];

export interface TextMatch {
  from: number;
  to: number;
}

const windowedTextLimit = 200;

/** Marks the text blocks holding the selection endpoints of a windowed document. */
function activeTextDecorations(state: EditorState, decorations: Decoration[]) {
  // Selection endpoints need their measured geometry before ProseMirror
  // scrolls to a distant find/outline result or a keyboard caret move.
  const active = new Set<number>();
  for (const point of [state.selection.$from, state.selection.$to]) {
    if (!point.depth || !point.node(1).isTextblock) continue;
    const from = point.before(1);
    if (active.has(from)) continue;
    active.add(from);
    decorations.push(
      Decoration.node(from, from + point.node(1).nodeSize, {
        class: 'ep-document-active-text',
      }),
    );
  }
}

function annotationDecorations(
  state: EditorState,
  content: DocumentContent,
  annotations: Annotation[],
  decorations: Decoration[],
) {
  const semantic = nodeToContent(state.doc, content);
  for (const annotation of annotations)
    for (const original of annotation.anchor.addresses) {
      const resolved = resolveDocumentAddress(semantic, original),
        region = resolved.address.region;
      if (resolved.state !== 'Current' || region?.type !== 'text' || region.start === region.end)
        continue;
      state.doc.descendants((node, pos) => {
        if (node.isTextblock && node.attrs.id === original.elementId)
          decorations.push(
            Decoration.inline(pos + 1 + region.start, pos + 1 + region.end, {
              class: annotation.resolved ? 'ep-comment-range resolved' : 'ep-comment-range',
              'data-annotation-id': annotation.id,
              title: annotation.comments[0]?.body ?? '',
            }),
          );
      });
    }
}

export function documentDecorations(
  state: EditorState,
  content: DocumentContent,
  annotations: Annotation[],
) {
  const decorations: Decoration[] = [];
  if (state.doc.childCount > windowedTextLimit || content.blocks.length > windowedTextLimit)
    activeTextDecorations(state, decorations);
  if (!annotations.length)
    return decorations.length ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty;
  annotationDecorations(state, content, annotations, decorations);
  return DecorationSet.create(state.doc, decorations);
}

/** A single collapsed non-paste replace step continues the current typing group. */
export function isTypingTransaction(tr: Transaction) {
  return (
    tr.steps.length === 1 &&
    tr.steps[0].toJSON().stepType === 'replace' &&
    tr.getMeta('uiEvent') !== 'paste' &&
    !tr.getMeta('explicit') &&
    tr.selection.empty
  );
}

export function isImageFile(file: File) {
  return file.type.startsWith('image/');
}

export function firstImageFile(files: FileList | undefined | null) {
  return Array.from(files ?? []).find(isImageFile);
}

export function findTextMatches(state: EditorState | null, search: string) {
  const matches: TextMatch[] = [];
  if (search && state)
    state.doc.descendants((node, pos) => {
      if (!node.isTextblock) return;
      const text = node.textBetween(0, node.content.size, '', '\n').toLocaleLowerCase(),
        query = search.toLocaleLowerCase();
      let index = 0;
      while ((index = text.indexOf(query, index)) >= 0) {
        matches.push({ from: pos + 1 + index, to: pos + 1 + index + search.length });
        index += search.length;
      }
      return false;
    });
  return matches;
}

export function hasDocumentMark(state: EditorState | null, name: string) {
  if (!state) return false;
  return state.selection.empty
    ? !!documentSchema.marks[name].isInSet(state.storedMarks ?? state.selection.$from.marks())
    : state.doc.rangeHasMark(state.selection.from, state.selection.to, documentSchema.marks[name]);
}

export function textStyleValue(state: EditorState | null) {
  const paragraphType = state?.selection.$from.parent.type.name,
    level = state?.selection.$from.parent.attrs.level ?? 1;
  return paragraphType === 'heading'
    ? `heading-${level}`
    : paragraphType === 'code_block'
      ? 'code_block'
      : 'paragraph';
}

export function outlineIndent(block: DocumentBlock) {
  return block.type === 'heading' ? 8 + (block.level ?? 1) * 8 : 16;
}

export function outlineLabel(block: DocumentBlock, index: number) {
  const prefix =
    block.type === 'heading' ? `H${block.level ?? 1}` : String(index + 1).padStart(2, '0');
  const text =
    block.type === 'image'
      ? block.alt || 'Image'
      : block.text.slice(0, 45) || blockLabels[block.type];
  return `${prefix} · ${text}`;
}

export function topLevelBlockPosition(state: EditorState | undefined, id: string) {
  let pos: number | undefined;
  state?.doc.forEach((n, p) => {
    if (n.attrs.id === id) pos = p;
  });
  return pos;
}

export function pageStyle(content: DocumentContent) {
  return {
    padding: content.page?.margin ?? 64,
    width: content.page?.size === 'Letter' ? 816 : 794,
  };
}

const referencesChanged = '取得中に参照接続が変わりました。再実行してください。';
const inputsChanged = '取得中に入力が変わりました。再実行してください。';

export interface DocumentTextBridge {
  state: EditorState;
  dispatch(transaction: Transaction): void;
  subscribe(listener: () => void): () => void;
  history(direction: 'undo' | 'redo'): void;
}

/** Latest props read by long-lived editor callbacks. */
export interface DocumentCallbacks {
  content: DocumentContent;
  execute: (command: EditorCommand<DocumentContent>) => void;
  select: (id: string, region?: Region) => void;
  readOnly: boolean;
  annotations: Annotation[];
  textEngine?: DocumentTextBridge;
  references?: ReferenceSurfaceProps['references'];
  history?: { undo(): void; redo(): void };
}

export interface CaptureGuard {
  callbacks: { current: DocumentCallbacks };
  references?: ReferenceSurfaceProps['references'];
  inputs?: EditorInputs;
}

export function assertReferencesUnchanged({ callbacks, references }: CaptureGuard) {
  if (callbacks.current.references !== references) throw new Error(referencesChanged);
}

export function assertCaptureCurrent(guard: CaptureGuard, initial: DocumentContent) {
  assertReferencesUnchanged(guard);
  if (
    guard.callbacks.current.content !== initial ||
    guard.inputs?.getSnapshot().dirty ||
    guard.inputs?.getSnapshot().composing
  )
    throw new Error(inputsChanged);
}
