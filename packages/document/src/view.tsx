import { useContext } from 'react';
import {
  EditorExportGuardContext,
  EditorOfficeCapabilitiesContext,
} from '@editor-platform/editor-ui';
import { useEffect, useRef, useState, useCallback, useMemo, memo, lazy, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  EditorState,
  TextSelection,
  NodeSelection,
  type Transaction,
  type Command,
} from 'prosemirror-state';
import { EditorView, Decoration, DecorationSet, type NodeView } from 'prosemirror-view';
import { textBlockView } from './text-block-view';
import { toggleMark, lift } from 'prosemirror-commands';
import {
  addColumnAfter,
  deleteColumn,
  deleteRow,
  mergeCells,
  splitCell,
  toggleHeaderRow,
  deleteTable,
} from 'prosemirror-tables';
import { sinkListItem, liftListItem, wrapInList } from 'prosemirror-schema-list';
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  Link,
  Highlighter,
  Plus,
  List,
  ListOrdered,
  ListChecks,
  IndentIncrease,
  IndentDecrease,
  Search,
  Download,
  ArrowUp,
  ArrowDown,
  Trash2,
  ImagePlus,
  AlignLeft,
  AlignCenter,
  AlignRight,
} from 'lucide-react';
import { canonicalJson, isDeepFrozen, newId } from '@editor-platform/artifact-core';
import {
  type EditorCommand,
  type Region,
  type Annotation,
  type ElementAddress,
} from '@editor-platform/editor-core';
import {
  EditorLayout,
  IconButton,
  Menu,
  Section,
  CommitInput,
  Dialog,
  type EditorLayoutProps,
} from '@editor-platform/editor-ui';
import { readImage, downloadBlob } from '@editor-platform/canvas-ui';
import {
  documentSchema,
  documentPlugins,
  addTableRowAndSelect,
  contentToNode,
  nodeToContent,
  blockNode,
  activeBlock,
  activeTextRange,
  jumpToBlock,
  formatBlock,
} from './engine';
import { localDocumentCommand } from './local-engine-command';
import {
  makeBlock,
  safeLink,
  exportHtml,
  exportMarkdown,
  resolveDocumentAddress,
  type BlockType,
  type DocumentBlock,
  type DocumentContent,
} from './model';
import { MermaidPreview, HtmlPreview } from './previews';
import { exportDocumentPdf, renderDocumentPages } from './print';
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-tables/style/tables.css';
import './styles.css';
const DocumentDocxDialog = lazy(() =>
  import('@editor-platform/office-export-ui/document').then((module) => ({
    default: module.DocumentDocxDialog,
  })),
);
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
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
function Embedded({ block }: { block: DocumentBlock }) {
  return block.type === 'image' ? (
    <figure>
      <img
        src={block.src}
        alt={block.alt || 'Document image'}
        style={{ width: block.width ?? '100%' }}
      />
      {block.caption && <figcaption>{block.caption}</figcaption>}
    </figure>
  ) : block.type === 'mermaid' ? (
    <MermaidPreview source={block.text} />
  ) : block.type === 'html' ? (
    <HtmlPreview source={block.text} />
  ) : (
    <div className="trusted-demo">
      <strong>Trusted React adapter</strong>
      <p>{block.text}</p>
    </div>
  );
}
function SourceInput({
  value,
  label,
  onCommit,
}: {
  value: string;
  label: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="ep-field">
      {label}
      <textarea
        aria-label={label}
        value={draft}
        rows={9}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== value) onCommit(draft);
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            e.currentTarget.value = value;
            setDraft(value);
            e.stopPropagation();
          }
        }}
      />
    </label>
  );
}
export interface DocumentTextBridge {
  state: EditorState;
  dispatch(transaction: Transaction): void;
  subscribe(listener: () => void): () => void;
  history(direction: 'undo' | 'redo'): void;
}
const DocumentOutlineRow = memo(function DocumentOutlineRow({
  id,
  label,
  indent,
  active,
  choose,
}: {
  id: string;
  label: string;
  indent: number;
  active: boolean;
  choose: (id: string) => void;
}) {
  return (
    <button
      className={`ep-outline-item ${active ? 'active' : ''}`}
      style={{ paddingLeft: indent }}
      onClick={() => choose(id)}
    >
      {label}
    </button>
  );
});
export interface DocumentSurfaceProps {
  textEngine?: DocumentTextBridge;
  content: DocumentContent;
  execute: (command: EditorCommand<DocumentContent>) => void;
  select: (id: string, region?: Region) => void;
  selectedId?: string;
  annotations?: Annotation[];
  focusAddress?: ElementAddress;
  readOnly?: boolean;
  layout?: Pick<EditorLayoutProps, 'panels' | 'defaultPanels' | 'onPanelsChange' | 'viewKey'>;
}
export function DocumentSurface({
  content,
  execute,
  select,
  selectedId,
  annotations = [],
  focusAddress,
  readOnly = false,
  layout,
  textEngine,
}: DocumentSurfaceProps) {
  const guardExport = useContext(EditorExportGuardContext);
  const officeCapability = useContext(EditorOfficeCapabilitiesContext);
  const mount = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null),
    callbacks = useRef({ content, execute, select, readOnly, annotations, textEngine });
  callbacks.current = { content, execute, select, readOnly, annotations, textEngine };
  const chooseOutline = useCallback((id: string) => {
    const editor = view.current;
    if (!editor) return;
    const tr = jumpToBlock(editor.state, id);
    if (tr) editor.dispatch(tr);
    editor.focus();
    callbacks.current.select(id);
  }, []);
  const [engineState, setEngineState] = useState<EditorState | null>(null),
    [error, setError] = useState(''),
    [linkOpen, setLinkOpen] = useState(false),
    [link, setLink] = useState('https://'),
    [search, setSearch] = useState(''),
    [replace, setReplace] = useState(''),
    [findOpen, setFindOpen] = useState(false),
    [matchIndex, setMatchIndex] = useState(0),
    [exporting, setExporting] = useState(false);
  const [docxOpen, setDocxOpen] = useState(false);
  // Only blocks belong to the text engine. Retained definitions/page settings
  // must not rebuild its DOM or be serialized on every React render.
  const emitted = useRef<{ blocks?: DocumentBlock[]; key?: string } | null>(null),
    typing = useRef({ key: newId('typing'), time: 0, position: -1 });
  if (emitted.current === null)
    emitted.current = {
      blocks: isDeepFrozen(content.blocks) ? content.blocks : undefined,
      key: canonicalJson(content.blocks),
    };
  useEffect(() => {
    if (!mount.current) return;
    const roots = new Set<Root>();
    const editor = new EditorView(mount.current, {
      decorations(state) {
        if (!callbacks.current.annotations.length) return DecorationSet.empty;
        const decorations: Decoration[] = [];
        const semantic = nodeToContent(state.doc, callbacks.current.content);
        for (const annotation of callbacks.current.annotations)
          for (const original of annotation.anchor.addresses) {
            const resolved = resolveDocumentAddress(semantic, original),
              region = resolved.address.region;
            if (
              resolved.state !== 'Current' ||
              region?.type !== 'text' ||
              region.start === region.end
            )
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
        return DecorationSet.create(state.doc, decorations);
      },
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
        embedded(node) {
          const dom = document.createElement('div');
          dom.className = 'ep-embedded';
          dom.contentEditable = 'false';
          dom.dataset.blockId = node.attrs.id;
          const root = createRoot(dom);
          roots.add(root);
          const render = () => root.render(<Embedded block={node.attrs.block} />);
          render();
          return {
            dom,
            update(next) {
              if (next.type !== node.type) return false;
              node = next;
              dom.dataset.blockId = node.attrs.id;
              render();
              return true;
            },
            destroy() {
              roots.delete(root);
              queueMicrotask(() => root.unmount());
            },
            stopEvent: (e) =>
              e.target instanceof Element && !!e.target.closest('input,textarea,button,iframe'),
          } satisfies NodeView;
        },
        list_item(node, editor, getPos) {
          const dom = document.createElement('li'),
            body = document.createElement('div'),
            check = document.createElement('input');
          body.className = 'ep-list-body';
          check.type = 'checkbox';
          check.contentEditable = 'false';
          check.setAttribute('aria-label', 'Complete checklist item');
          check.onchange = () => {
            const pos = getPos();
            if (pos !== undefined && !callbacks.current.readOnly)
              editor.dispatch(
                editor.state.tr.setNodeMarkup(pos, undefined, {
                  ...node.attrs,
                  checked: check.checked,
                }),
              );
          };
          dom.append(check, body);
          const update = () => {
            check.hidden = node.attrs.checked === null;
            check.checked = !!node.attrs.checked;
            check.disabled = callbacks.current.readOnly;
            dom.dataset.checked = node.attrs.checked === null ? '' : String(node.attrs.checked);
          };
          update();
          return {
            dom,
            contentDOM: body,
            update(next) {
              if (next.type !== node.type) return false;
              node = next;
              update();
              return true;
            },
            stopEvent: (e) => e.target === check,
          } satisfies NodeView;
        },
      },
      dispatchTransaction(tr) {
        if (tr.docChanged && callbacks.current.readOnly) return;
        try {
          const previousPosition = editor.state.selection.from;
          const bridge = callbacks.current.textEngine;
          const applied = bridge
            ? (bridge.dispatch(tr), { state: bridge.state, transactions: [] })
            : editor.state.applyTransaction(tr);
          editor.updateState(applied.state);
          setEngineState(applied.state);
          if (applied.transactions.some((t) => t.docChanged)) {
            const now = Date.now(),
              isTyping =
                tr.steps.length === 1 &&
                tr.steps[0].toJSON().stepType === 'replace' &&
                tr.getMeta('uiEvent') !== 'paste' &&
                !tr.getMeta('explicit') &&
                tr.selection.empty;
            if (
              !isTyping ||
              now - typing.current.time > 800 ||
              previousPosition !== typing.current.position
            )
              typing.current.key = newId('typing');
            const { command: cmd, content: next } = localDocumentCommand(
              callbacks.current.content,
              applied.state.doc,
              {
                origin: 'local',
                transactionId: newId('transaction'),
                ...(isTyping ? { mergeKey: typing.current.key } : {}),
              },
            );
            emitted.current = { blocks: next.blocks };
            callbacks.current.content = next;
            callbacks.current.execute(cmd);
            typing.current.time = now;
            typing.current.position = tr.selection.from;
            setError('');
          } else if (tr.selectionSet) {
            typing.current.key = newId('typing');
            typing.current.position = tr.selection.from;
          }
          const block = activeTextRange(applied.state);
          if (block)
            callbacks.current.select(block.id, {
              type: 'text',
              start: block.start,
              end: block.end,
            });
          else if (applied.state.selection instanceof NodeSelection) {
            const id = applied.state.selection.node.attrs.id;
            if (id) callbacks.current.select(id);
          }
        } catch (e) {
          setError((e as Error).message);
        }
      },
      handlePaste(_view, event) {
        const file = Array.from(event.clipboardData?.files ?? []).find((f) =>
          f.type.startsWith('image/'),
        );
        if (!file || callbacks.current.readOnly) return false;
        void imageFile(file);
        return true;
      },
      handleDrop(_view, event) {
        const file = Array.from(event.dataTransfer?.files ?? []).find((f) =>
          f.type.startsWith('image/'),
        );
        if (!file || callbacks.current.readOnly) return false;
        void imageFile(file);
        return true;
      },
      handleKeyDown(editor, event) {
        if (
          callbacks.current.textEngine &&
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === 'z'
        ) {
          event.preventDefault();
          callbacks.current.textEngine.history(event.shiftKey ? 'redo' : 'undo');
          return true;
        }
        if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault();
          move(event.key === 'ArrowUp' ? -1 : 1);
          return true;
        }
        if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
          event.preventDefault();
          setFindOpen(true);
          return true;
        }
        if (event.key === '/' && editor.state.selection.$from.parent.textContent === '') {
          event.preventDefault();
          setInsertOpen(true);
          return true;
        }
        return false;
      },
    });
    view.current = editor;
    setEngineState(editor.state);
    const stop = textEngine?.subscribe(() => {
      if (view.current && view.current.state !== textEngine.state) {
        view.current.updateState(textEngine.state);
        setEngineState(textEngine.state);
      }
    });
    return () => {
      stop?.();
      view.current = null;
      editor.destroy();
      roots.forEach((root) => queueMicrotask(() => root.unmount()));
    };
  }, []);
  useEffect(() => {
    const editor = view.current;
    if (editor) editor.updateState(editor.state);
  }, [annotations]);
  useEffect(() => {
    const editor = view.current;
    if (!editor || !focusAddress) return;
    const resolved = resolveDocumentAddress(content, focusAddress),
      range = resolved.address.region;
    if (resolved.state !== 'Current') return;
    editor.state.doc.descendants((node, pos) => {
      if (!node.isTextblock || node.attrs.id !== resolved.address.elementId) return;
      const start = range?.type === 'text' ? range.start : 0,
        end = range?.type === 'text' ? range.end : 0;
      editor.dispatch(
        editor.state.tr
          .setSelection(TextSelection.create(editor.state.doc, pos + 1 + start, pos + 1 + end))
          .scrollIntoView(),
      );
      editor.focus();
    });
  }, [focusAddress]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (textEngine) return;
    editor.setProps({ editable: () => !readOnly });
    editor.dom.setAttribute('aria-readonly', String(readOnly));
    editor.dom.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((input) => {
      input.disabled = readOnly;
    });
    const previous = emitted.current!;
    if (previous.blocks === content.blocks && isDeepFrozen(content.blocks)) return;
    const key = canonicalJson(content.blocks),
      previousKey = previous.key ?? canonicalJson(previous.blocks);
    emitted.current = {
      blocks: isDeepFrozen(content.blocks) ? content.blocks : undefined,
      key,
    };
    if (key !== previousKey) {
      const doc = contentToNode(content),
        position = Math.min(editor.state.selection.from, doc.content.size),
        state = EditorState.create({
          doc,
          plugins: documentPlugins(),
          selection: TextSelection.near(doc.resolve(position)),
        });
      editor.updateState(state);
      setEngineState(state);
      typing.current.key = newId('typing');
    }
  }, [content, readOnly, textEngine]);
  useEffect(() => {
    if (!view.current) return;
    view.current.dom.setAttribute('aria-readonly', String(readOnly));
    view.current.setProps({ editable: () => !readOnly });
    view.current.dom.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((input) => {
      input.disabled = readOnly;
    });
  }, [readOnly, textEngine]);
  const [insertOpen, setInsertOpen] = useState(false);
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
      const pages = await renderDocumentPages(content);
      if (generation === printGeneration.current)
        setPrintPages(pages.map((p) => p.toDataURL('image/png')));
    } catch (e) {
      if (generation === printGeneration.current) {
        setError(String(e));
        setPrintPages(undefined);
      }
    }
  }
  function run(cmd: Command) {
    const editor = view.current;
    if (!editor || readOnly) return;
    cmd(editor.state, (tr) => editor.dispatch(tr.setMeta('explicit', true)), editor);
    editor.focus();
  }
  function dispatch(tr: Transaction) {
    if (!readOnly) view.current?.dispatch(tr.setMeta('explicit', true));
  }
  function insert(type: BlockType, patch: Partial<DocumentBlock> = {}) {
    const editor = view.current;
    if (!editor || callbacks.current.readOnly) return;
    const b = { ...makeBlock(type), ...patch };
    const $from = editor.state.selection.$from;
    const pos = $from.depth ? $from.after(1) : editor.state.selection.to;
    const node = blockNode(b);
    const tr = editor.state.tr.insert(pos, node);
    dispatch(
      tr
        .setSelection(
          node.isAtom
            ? NodeSelection.create(tr.doc, pos)
            : TextSelection.near(tr.doc.resolve(pos + 1)),
        )
        .scrollIntoView(),
    );
    editor.focus();
    setInsertOpen(false);
  }
  async function imageFile(file: File) {
    try {
      const src = await readImage(file);
      const image = new Image();
      image.src = src;
      await image.decode();
      insert('image', { src, alt: file.name, width: Math.min(600, image.width) });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const selected = content.blocks.find(
    (b) => b.id === ((engineState ? activeBlock(engineState)?.id : undefined) ?? selectedId),
  );
  function blockPosition(id: string) {
    let pos: number | undefined;
    view.current?.state.doc.forEach((n, p) => {
      if (n.attrs.id === id) pos = p;
    });
    return pos;
  }
  function patchBlock(patch: Partial<DocumentBlock>) {
    if (!selected || !view.current || readOnly) return;
    const pos = blockPosition(selected.id);
    if (pos === undefined) return;
    const node = blockNode({ ...selected, ...patch });
    dispatch(
      view.current.state.tr.replaceWith(
        pos,
        pos + view.current.state.doc.nodeAt(pos)!.nodeSize,
        node,
      ),
    );
  }
  function move(delta: number) {
    const editor = view.current;
    if (!editor || callbacks.current.readOnly) return;
    const id = activeBlock(editor.state)?.id ?? selectedId,
      index = callbacks.current.content.blocks.findIndex((b) => b.id === id),
      target = index + delta;
    if (index < 0 || target < 0 || target >= callbacks.current.content.blocks.length) return;
    const from = blockPosition(id!),
      node = editor.state.doc.nodeAt(from!)!;
    let to = blockPosition(callbacks.current.content.blocks[target].id)!;
    if (delta > 0) to += editor.state.doc.nodeAt(to)!.nodeSize;
    const tr = editor.state.tr.delete(from!, from! + node.nodeSize);
    tr.insert(tr.mapping.map(to), node);
    dispatch(tr);
  }
  function remove() {
    if (!selected || !view.current) return;
    const pos = blockPosition(selected.id)!;
    dispatch(view.current.state.tr.delete(pos, pos + view.current.state.doc.nodeAt(pos)!.nodeSize));
  }
  function mark(name: string, attrs?: Record<string, string>) {
    run(toggleMark(documentSchema.marks[name], attrs));
  }
  function hasMark(name: string) {
    const state = engineState;
    if (!state) return false;
    return state.selection.empty
      ? !!documentSchema.marks[name].isInSet(state.storedMarks ?? state.selection.$from.marks())
      : state.doc.rangeHasMark(
          state.selection.from,
          state.selection.to,
          documentSchema.marks[name],
        );
  }
  const matches: { from: number; to: number }[] = [];
  if (search && engineState)
    engineState.doc.descendants((node, pos) => {
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

  function find(index: number) {
    const editor = view.current;
    if (!editor || !matches.length) return;
    const i = (index + matches.length) % matches.length;
    setMatchIndex(i);
    editor.dispatch(
      editor.state.tr
        .setSelection(TextSelection.create(editor.state.doc, matches[i].from, matches[i].to))
        .scrollIntoView(),
    );
    editor.focus();
  }
  function replaceMatches(all: boolean) {
    const editor = view.current;
    if (!editor || readOnly || !matches.length) return;
    const tr = editor.state.tr;
    for (const match of (all ? matches : [matches[matchIndex % matches.length]]).slice().reverse())
      tr.insertText(replace, match.from, match.to);
    dispatch(tr);
  }
  const paragraphType = engineState?.selection.$from.parent.type.name,
    level = engineState?.selection.$from.parent.attrs.level ?? 1;
  const toolButton = (
    label: string,
    icon: Parameters<typeof IconButton>[0]['icon'],
    action: () => void,
    pressed?: boolean,
  ) => (
    <IconButton
      key={label}
      label={label}
      icon={icon}
      disabled={readOnly}
      aria-pressed={pressed}
      onMouseDown={(e) => e.preventDefault()}
      onClick={action}
    />
  );
  const tableActions: [string, Command][] = [
    ['Add table row', addTableRowAndSelect],
    ['Add table column', addColumnAfter],
    ['Remove table row', deleteRow],
    ['Remove table column', deleteColumn],
    ['Merge cells', mergeCells],
    ['Split cell', splitCell],
    ['Toggle table header', toggleHeaderRow],
    ['Delete table', deleteTable],
  ];
  const outline = (
    <>
      {content.blocks.map((b, i) => (
        <DocumentOutlineRow
          key={b.id}
          id={b.id}
          active={selected?.id === b.id}
          indent={b.type === 'heading' ? 8 + (b.level ?? 1) * 8 : 16}
          label={`${b.type === 'heading' ? `H${b.level ?? 1}` : String(i + 1).padStart(2, '0')} · ${
            b.type === 'image' ? b.alt || 'Image' : b.text.slice(0, 45) || blockLabels[b.type]
          }`}
          choose={chooseOutline}
        />
      ))}
    </>
  );
  const inspector = (
    <>
      <Section title="Block">
        {selected ? (
          <>
            <p>{blockLabels[selected.type]}</p>
            <div className="ep-inline">
              {toolButton('Move block up', ArrowUp, () => move(-1))}
              {toolButton('Move block down', ArrowDown, () => move(1))}
              {toolButton('Delete block', Trash2, remove)}
            </div>
            <fieldset disabled={readOnly}>
              {selected.type === 'image' ? (
                <>
                  <CommitInput
                    label="Alt text"
                    value={selected.alt ?? ''}
                    onCommit={(alt) => patchBlock({ alt })}
                  />
                  <CommitInput
                    label="Image width"
                    value={selected.width ?? 600}
                    type="number"
                    min={40}
                    max={1200}
                    onCommit={(v) => patchBlock({ width: Number(v) })}
                  />
                  <CommitInput
                    label="Caption"
                    value={selected.caption ?? ''}
                    onCommit={(caption) => patchBlock({ caption })}
                  />
                </>
              ) : ['mermaid', 'html', 'react-preview'].includes(selected.type) ? (
                <SourceInput
                  label={`${blockLabels[selected.type]} source`}
                  value={selected.text}
                  onCommit={(text) => patchBlock({ text })}
                />
              ) : selected.type === 'code' ? (
                <CommitInput
                  label="Code language"
                  value={selected.language ?? 'text'}
                  onCommit={(language) => patchBlock({ language })}
                />
              ) : (
                <>
                  <div className="ep-inline">
                    {toolButton('Align left', AlignLeft, () => patchBlock({ align: 'left' }))}
                    {toolButton('Align center', AlignCenter, () => patchBlock({ align: 'center' }))}
                    {toolButton('Align right', AlignRight, () => patchBlock({ align: 'right' }))}
                  </div>
                  <label className="ep-field">
                    Text color
                    <input
                      aria-label="Document text color"
                      type="color"
                      defaultValue="#253044"
                      onChange={(e) => mark('color', { value: e.target.value })}
                    />
                  </label>
                </>
              )}
            </fieldset>
          </>
        ) : (
          <p>Select a block.</p>
        )}
      </Section>
      <Section title="Table">
        <div className="ep-action-grid">
          {tableActions.map(([label, cmd]) => (
            <button
              key={label}
              disabled={readOnly || !engineState || !cmd(engineState)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(cmd)}
            >
              {label}
            </button>
          ))}
        </div>
      </Section>
      <Section title="Page">
        <fieldset disabled={readOnly}>
          <label className="ep-field">
            Paper size
            <select
              aria-label="Paper size"
              value={content.page?.size ?? 'A4'}
              onChange={(e) => pageSetting({ size: e.target.value as 'A4' | 'Letter' })}
            >
              <option>A4</option>
              <option>Letter</option>
            </select>
          </label>
          <CommitInput
            label="Page margin"
            value={content.page?.margin ?? 64}
            type="number"
            min={24}
            max={160}
            onCommit={(v) => pageSetting({ margin: Number(v) })}
          />
        </fieldset>
      </Section>
    </>
  );
  function pageSetting(patch: Partial<NonNullable<DocumentContent['page']>>) {
    if (readOnly) return;
    execute({
      type: 'document.page',
      label: 'Page setup',
      apply: (d) => ({ ...d, page: { size: 'A4', margin: 64, ...d.page, ...patch } }),
    });
  }
  async function exportFile(format: 'md' | 'html' | 'pdf') {
    setExporting(true);
    try {
      guardExport?.();
      const snapshot = callbacks.current.content;
      if (format === 'pdf') await exportDocumentPdf(snapshot);
      else
        downloadBlob(
          `document.${format}`,
          new Blob([format === 'md' ? exportMarkdown(snapshot) : exportHtml(snapshot)], {
            type: format === 'md' ? 'text/markdown' : 'text/html',
          }),
        );
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }
  const words = content.blocks
    .map((b) => (b.type === 'table' ? (b.cells?.flat().join(' ') ?? '') : b.text))
    .join(' ');
  const wordCount = useMemo(() => {
    let count = 0;
    for (const segment of wordSegmenter.segment(words)) if (segment.isWordLike) count++;
    return count;
  }, [words]);
  return (
    <EditorLayout
      {...layout}
      viewKey={layout?.viewKey ?? 'document'}
      leftLabel="Document outline"
      inspectorLabel="Document inspector"
      left={outline}
      inspector={inspector}
      status={
        <>
          <span>
            {wordCount} words · {words.length} characters · {content.blocks.length} blocks
          </span>
          <span className="ep-spacer" />
          <span>{readOnly ? 'Read only' : 'Rich text · / to insert'}</span>
        </>
      }
      toolbar={
        <>
          <select
            aria-label="Text style"
            disabled={readOnly}
            value={
              paragraphType === 'heading'
                ? `heading-${level}`
                : paragraphType === 'code_block'
                  ? 'code_block'
                  : 'paragraph'
            }
            onChange={(e) => {
              const [type, l] = e.target.value.split('-');
              run((state, dispatch) => formatBlock(state, dispatch, type, Number(l) || 1));
            }}
          >
            <option value="paragraph">Paragraph</option>
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={`heading-${n}`}>
                Heading {n}
              </option>
            ))}
            <option value="code_block">Code</option>
          </select>
          {toolButton('Bold', Bold, () => mark('bold'), hasMark('bold'))}
          {toolButton('Italic', Italic, () => mark('italic'), hasMark('italic'))}
          {toolButton('Underline', Underline, () => mark('underline'), hasMark('underline'))}
          <Menu label="More formatting">
            <div className="ep-inline">
              {toolButton('Strikethrough', Strikethrough, () => mark('strike'), hasMark('strike'))}
              {toolButton('Inline code', Code, () => mark('code'), hasMark('code'))}
              {toolButton(
                'Highlight',
                Highlighter,
                () => mark('highlight', { value: '#fff0a8' }),
                hasMark('highlight'),
              )}
              {toolButton('Link', Link, () => setLinkOpen(true), hasMark('link'))}
            </div>
          </Menu>
          {toolButton('Bulleted list', List, () =>
            run(wrapInList(documentSchema.nodes.bullet_list)),
          )}
          {toolButton('Numbered list', ListOrdered, () =>
            run(wrapInList(documentSchema.nodes.ordered_list)),
          )}
          {toolButton('Checklist', ListChecks, () => {
            run(wrapInList(documentSchema.nodes.bullet_list, { check: true }));
            const editor = view.current;
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
              dispatch(tr);
            }
          })}
          <Menu label="Indentation">
            <div className="ep-inline">
              {toolButton('Indent', IndentIncrease, () =>
                run(sinkListItem(documentSchema.nodes.list_item)),
              )}
              {toolButton('Outdent', IndentDecrease, () =>
                run(
                  (s, d, v) =>
                    liftListItem(documentSchema.nodes.list_item)(s, d, v) || lift(s, d, v),
                ),
              )}
            </div>
          </Menu>
          <IconButton
            icon={Plus}
            label="Insert block"
            disabled={readOnly}
            onClick={() => setInsertOpen(true)}
          />
          <label className="ep-upload" title="Insert image">
            <ImagePlus size={19} />
            <input
              type="file"
              aria-label="Document image file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              disabled={readOnly}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void imageFile(file);
                e.target.value = '';
              }}
            />
          </label>
          <IconButton
            icon={Search}
            label="Find and replace"
            onClick={() => setFindOpen(!findOpen)}
          />
          <Menu label="Export document" icon={Download}>
            <button onClick={() => void printPreview()}>Print preview</button>
            <button
              disabled={!officeCapability.docx}
              title={
                !officeCapability.docx
                  ? (officeCapability.reason ?? 'Hostはこの形式の出力を提供していません。')
                  : undefined
              }
              onClick={() => setDocxOpen(true)}
            >
              Export DOCX
            </button>
            <p>
              PDFの本文・表は検索/コピーできます。図・画像内の文字は画像です。Tagged
              PDFは未対応です。大きい画像は1ページへ縮小し、表は行または文字行で分割します。
            </p>
            {(['md', 'html', 'pdf'] as const).map((format) => (
              <button key={format} disabled={exporting} onClick={() => void exportFile(format)}>
                Export {format.toUpperCase()}
              </button>
            ))}
          </Menu>
        </>
      }
    >
      <div className="ep-document-scroll">
        {findOpen && (
          <div className="ep-find">
            <input
              aria-label="Find text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setMatchIndex(0);
              }}
            />
            <span>{matches.length} matches</span>
            <button disabled={!matches.length} onClick={() => find(matchIndex + 1)}>
              Next match
            </button>
            <input
              aria-label="Replacement text"
              value={replace}
              onChange={(e) => setReplace(e.target.value)}
            />
            <button disabled={readOnly || !matches.length} onClick={() => replaceMatches(false)}>
              Replace
            </button>
            <button disabled={readOnly || !matches.length} onClick={() => replaceMatches(true)}>
              Replace all
            </button>
            <button onClick={() => setFindOpen(false)}>Close find</button>
          </div>
        )}
        {error && (
          <p role="alert" className="ep-error">
            {error}
          </p>
        )}
        <div
          className="ep-document-page"
          style={{
            padding: content.page?.margin ?? 64,
            width: content.page?.size === 'Letter' ? 816 : 794,
          }}
        >
          <div ref={mount} />
        </div>
      </div>
      {docxOpen && (
        <Suspense fallback={<p role="status">Loading DOCX export…</p>}>
          <DocumentDocxDialog
            content={content}
            onClose={() => setDocxOpen(false)}
            onNavigate={(address) => {
              if (!address.blockId) return;
              select(address.blockId);
              if (view.current) {
                const transaction = jumpToBlock(view.current.state, address.blockId);
                if (transaction) view.current.dispatch(transaction);
                view.current.focus();
              }
            }}
          />
        </Suspense>
      )}
      {printPages !== undefined && (
        <Dialog
          title="Document print preview"
          onClose={() => {
            printGeneration.current++;
            setPrintPages(undefined);
          }}
        >
          <p>
            {printPages
              ? `${printPages.length} pages · Same pagination as exported PDF`
              : 'Rendering print pages…'}
          </p>
          <div className="ep-print-pages">
            {printPages?.map((src, i) => (
              <img key={i} src={src} alt={`Print page ${i + 1}`} />
            ))}
          </div>
        </Dialog>
      )}
      {insertOpen && (
        <Dialog
          title="Insert document block"
          onClose={() => {
            setInsertOpen(false);
            view.current?.focus();
          }}
        >
          <div className="ep-block-picker">
            {Object.entries(blockLabels).map(([type, label]) => (
              <button key={type} onClick={() => insert(type as BlockType)}>
                {label}
              </button>
            ))}
          </div>
        </Dialog>
      )}
      {linkOpen && (
        <Dialog title="Edit link" onClose={() => setLinkOpen(false)}>
          <label>
            Link URL
            <input aria-label="Link URL" value={link} onChange={(e) => setLink(e.target.value)} />
          </label>
          <button
            disabled={!safeLink(link)}
            onClick={() => {
              mark('link', { href: link });
              setLinkOpen(false);
            }}
          >
            Apply link
          </button>
          <button
            onClick={() => {
              const editor = view.current;
              if (editor)
                dispatch(
                  editor.state.tr.removeMark(
                    editor.state.selection.from,
                    editor.state.selection.to,
                    documentSchema.marks.link,
                  ),
                );
              setLinkOpen(false);
            }}
          >
            Remove link
          </button>
        </Dialog>
      )}
    </EditorLayout>
  );
}
