import { useEffect, useRef, useState } from 'react';
import { EditorState, TextSelection, NodeSelection, type Transaction } from 'prosemirror-state';
import { type Node as ProseMirrorNode } from 'prosemirror-model';
import { type EditorView } from 'prosemirror-view';
import { canonicalJson, isDeepFrozen, newId } from '@editor-platform/artifact-core';
import { type Annotation, type ElementAddress, type Region } from '@editor-platform/editor-core';
import { downloadBlob } from '@editor-platform/canvas-ui';
import { documentPlugins, contentToNode } from './engine';
import { sameDocumentProjection } from './local-engine-command';
import { exportHtml, exportMarkdown, resolveDocumentAddress, type DocumentContent } from './model';
import { exportDocumentPdf, renderDocumentPages } from './print';
import { captureDocumentReferences } from './references';
import { type EmittedProjection, type TypingGroup } from './view-editor';
import {
  assertCaptureCurrent,
  assertReferencesUnchanged,
  findTextMatches,
  type CaptureGuard,
} from './view-model';

type ViewRef = { current: EditorView | null };

export function useEmbeddedRefresh(
  embeddedViews: { current: Set<() => void> },
  references: unknown,
) {
  useEffect(() => {
    for (const render of embeddedViews.current) render();
  }, [references]);
}

export function useAnnotationRefresh(view: ViewRef, annotations: Annotation[]) {
  useEffect(() => {
    const editor = view.current;
    if (editor) editor.updateState(editor.state);
  }, [annotations]);
}

function revealEmbedded(view: ViewRef, editor: EditorView, node: ProseMirrorNode, pos: number) {
  editor.focus();
  editor.dispatch(
    editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)).scrollIntoView(),
  );
  const dom = editor.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return undefined;
  const reveal = () => {
    const selected = editor.state.selection;
    if (
      view.current === editor &&
      selected instanceof NodeSelection &&
      selected.node.attrs.id === node.attrs.id
    )
      dom.scrollIntoView({ block: 'center', inline: 'nearest' });
  };
  // React node views and their images can acquire their height after selection.
  let frame = requestAnimationFrame(reveal);
  const loaded = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(reveal);
  };
  dom.addEventListener('load', loaded, { capture: true, once: true });
  return () => {
    cancelAnimationFrame(frame);
    dom.removeEventListener('load', loaded, true);
  };
}

function selectTextRegion(editor: EditorView, pos: number, range: Region | undefined) {
  const start = range?.type === 'text' ? range.start : 0,
    end = range?.type === 'text' ? range.end : 0;
  editor.focus();
  editor.dispatch(
    editor.state.tr
      .setSelection(TextSelection.create(editor.state.doc, pos + 1 + start, pos + 1 + end))
      .scrollIntoView(),
  );
}

export function useFocusAddress(
  view: ViewRef,
  content: DocumentContent,
  focusAddress: ElementAddress | undefined,
) {
  useEffect(() => {
    const editor = view.current;
    if (!editor || !focusAddress) return;
    const resolved = resolveDocumentAddress(content, focusAddress),
      range = resolved.address.region;
    if (resolved.state !== 'Current') return;
    let stopReveal: (() => void) | undefined;
    editor.state.doc.descendants((node, pos) => {
      if (node.attrs.id !== resolved.address.elementId) return;
      if (node.type.name === 'embedded') {
        stopReveal = revealEmbedded(view, editor, node, pos) ?? stopReveal;
        return false;
      }
      if (!node.isTextblock) return;
      selectTextRegion(editor, pos, range);
    });
    return () => stopReveal?.();
  }, [focusAddress]);
}

function setReadOnlyDom(editor: EditorView, readOnly: boolean) {
  editor.dom.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((input) => {
    input.disabled = readOnly;
  });
}

export interface ContentSyncContext {
  view: ViewRef;
  emitted: { current: EmittedProjection };
  typing: { current: TypingGroup };
  setEngineState: (state: EditorState) => void;
}

function replaceEngineState(ctx: ContentSyncContext, editor: EditorView, content: DocumentContent) {
  const doc = contentToNode(content),
    position = Math.min(editor.state.selection.from, doc.content.size),
    state = EditorState.create({
      doc,
      plugins: documentPlugins(),
      selection: TextSelection.near(doc.resolve(position)),
    });
  editor.updateState(state);
  ctx.setEngineState(state);
  ctx.typing.current.key = newId('typing');
}

/** Rebuilds the local engine when Host blocks differ from the last emitted projection. */
export function useContentSync(
  ctx: ContentSyncContext,
  content: DocumentContent,
  readOnly: boolean,
  textEngine: unknown,
) {
  useEffect(() => {
    const editor = ctx.view.current;
    if (!editor) return;
    if (textEngine) return;
    editor.setProps({ editable: () => !readOnly });
    editor.dom.setAttribute('aria-readonly', String(readOnly));
    setReadOnlyDom(editor, readOnly);
    const previous = ctx.emitted.current!;
    if (previous.blocks && sameDocumentProjection(previous.blocks, content.blocks)) return;
    const key = canonicalJson(content.blocks),
      previousKey = previous.key ?? canonicalJson(previous.blocks);
    ctx.emitted.current = {
      blocks: isDeepFrozen(content.blocks) ? content.blocks : undefined,
      key,
    };
    if (key !== previousKey) replaceEngineState(ctx, editor, content);
  }, [content, readOnly, textEngine]);
}

export function useReadOnlySync(view: ViewRef, readOnly: boolean, textEngine: unknown) {
  useEffect(() => {
    if (!view.current) return;
    view.current.dom.setAttribute('aria-readonly', String(readOnly));
    view.current.setProps({ editable: () => !readOnly });
    setReadOnlyDom(view.current, readOnly);
  }, [readOnly, textEngine]);
}

export interface DocumentCaptureContext extends CaptureGuard {
  guardExport?: () => void;
  setError: (message: string) => void;
}

export function usePrintPreview(ctx: DocumentCaptureContext) {
  const [printPages, setPrintPages] = useState<string[] | null>();
  const printGeneration = useRef(0);
  useEffect(
    () => () => {
      printGeneration.current++;
    },
    [],
  );
  async function printPreview() {
    const generation = ++printGeneration.current;
    setPrintPages(null);
    try {
      ctx.guardExport?.();
      const initial = ctx.callbacks.current.content;
      const captured = await captureDocumentReferences(initial, ctx.references);
      assertCaptureCurrent(ctx, initial);
      const pages = await renderDocumentPages(captured);
      assertReferencesUnchanged(ctx);
      if (generation === printGeneration.current)
        setPrintPages(pages.map((p) => p.toDataURL('image/png')));
    } catch (e) {
      if (generation === printGeneration.current) {
        ctx.setError(String(e));
        setPrintPages(undefined);
      }
    }
  }
  function closePrintPreview() {
    printGeneration.current++;
    setPrintPages(undefined);
  }
  return { printPages, printPreview, closePrintPreview };
}

export type DocumentExportFormat = 'md' | 'html' | 'pdf';

function downloadDocument(format: 'md' | 'html', snapshot: DocumentContent) {
  downloadBlob(
    `document.${format}`,
    new Blob([format === 'md' ? exportMarkdown(snapshot) : exportHtml(snapshot)], {
      type: format === 'md' ? 'text/markdown' : 'text/html',
    }),
  );
}

export function useDocumentExport(ctx: DocumentCaptureContext) {
  const [exporting, setExporting] = useState(false);
  async function exportFile(format: DocumentExportFormat) {
    setExporting(true);
    try {
      ctx.guardExport?.();
      const initial = ctx.callbacks.current.content;
      const snapshot = await captureDocumentReferences(initial, ctx.references, format === 'md');
      assertCaptureCurrent(ctx, initial);
      if (format === 'pdf') await exportDocumentPdf(snapshot);
      else downloadDocument(format, snapshot);
      ctx.setError('');
    } catch (e) {
      ctx.setError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }
  return { exporting, exportFile };
}

export function useFindReplace(
  view: ViewRef,
  engineState: EditorState | null,
  readOnly: boolean,
  dispatch: (tr: Transaction) => void,
) {
  const [search, setSearch] = useState(''),
    [replace, setReplace] = useState(''),
    [findOpen, setFindOpen] = useState(false),
    [matchIndex, setMatchIndex] = useState(0);
  const matches = findTextMatches(engineState, search);
  function find(index: number) {
    const editor = view.current;
    if (!editor || !matches.length) return;
    const i = (index + matches.length) % matches.length;
    setMatchIndex(i);
    // ProseMirror scrolls its text selection only while the DOM selection is in
    // the editor. Focus before measuring a previously skipped search result.
    editor.focus();
    editor.dispatch(
      editor.state.tr
        .setSelection(TextSelection.create(editor.state.doc, matches[i].from, matches[i].to))
        .scrollIntoView(),
    );
  }
  function replaceMatches(all: boolean) {
    const editor = view.current;
    if (!editor || readOnly || !matches.length) return;
    const tr = editor.state.tr;
    for (const match of (all ? matches : [matches[matchIndex % matches.length]]).slice().reverse())
      tr.insertText(replace, match.from, match.to);
    dispatch(tr);
  }
  function changeSearch(value: string) {
    setSearch(value);
    setMatchIndex(0);
  }
  return {
    search,
    replace,
    setReplace,
    findOpen,
    setFindOpen,
    matchIndex,
    matches,
    find,
    replaceMatches,
    changeSearch,
  };
}
