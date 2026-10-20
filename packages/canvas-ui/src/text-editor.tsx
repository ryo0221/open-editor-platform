import { createContext, useContext, useEffect, useRef, useState, type CSSProperties } from 'react';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { baseKeymap, toggleMark } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import { history, undo, redo } from 'prosemirror-history';
import { createPortal } from 'react-dom';
import {
  layoutDrawingText,
  type Drawing,
  type TextRun,
  type TextStyle,
} from '@editor-platform/editor-core';
import { EditorUncommittedInputContext, useEditorInput } from '@editor-platform/editor-ui';
import { canvasTextLayout } from './text-layout';

import {
  canvasTextSchema,
  canvasTextDocument,
  canvasTextValue,
  canvasTextMarks as marks,
} from './text-engine';
export { canvasTextSchema, canvasTextDocument, canvasTextValue } from './text-engine';
/** A Host-injected engine, with no knowledge of transport, Room or organization policy. */
export interface CanvasTextBridge {
  state: EditorState;
  dispatch(transaction: Transaction): void;
  subscribe(listener: () => void): () => void;
  history(direction: 'undo' | 'redo'): void;
}
export const CanvasTextContext = createContext<
  ((elementId: string) => CanvasTextBridge) | undefined
>(undefined);

/** Private edit buffer; blur/Done emits one domain command, Escape leaves content unchanged. */
export function CanvasTextEditor({
  elementId,
  text,
  runs,
  style = {},
  readOnly,
  onCommit,
  onCancel,
  drawing,
  caret,
  toolsContainer,
  toolsPosition,
  expanded,
  onExpand,
  stale = false,
}: {
  elementId: string;
  text: string;
  runs?: TextRun[];
  style?: TextStyle;
  readOnly: boolean;
  onCommit: (text: string, runs: TextRun[]) => void | boolean;
  onCancel: () => void;
  drawing?: Drawing;
  caret?: { x: number; y: number };
  toolsContainer?: HTMLElement | null;
  toolsPosition?: { x: number; y: number };
  expanded?: boolean;
  onExpand?: () => void;
  stale?: boolean;
}) {
  const bridgeFactory = useContext(CanvasTextContext);
  const privateInputs = useContext(EditorUncommittedInputContext);
  const bridge = bridgeFactory?.(elementId);
  const root = useRef<HTMLDivElement>(null),
    mount = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | undefined>(undefined);
  const tools = useRef<HTMLDivElement>(null);
  const originalDoc = useRef<EditorState['doc'] | undefined>(undefined);
  const currentDrawing = useRef(drawing);
  currentDrawing.current = drawing;
  const [, refresh] = useState(0);
  const completed = useRef(false),
    callbacks = useRef({ onCommit, onCancel, readOnly, stale });
  callbacks.current = { onCommit, onCancel, readOnly, stale };
  const [active, setActive] = useState<string[]>([]);
  const [error, setError] = useState('');
  const finish = (cancel = false) => {
    // Toolbar/export focus must not serialize and detach an unfinished IME buffer.
    if (view.current?.composing) return false;
    if (completed.current) return true;
    if (!cancel && !bridge && (callbacks.current.readOnly || callbacks.current.stale)) {
      setError(
        '文字または書式が変更済み、または編集できません。入力をコピーして現在値を確認してください。',
      );
      return false;
    }
    completed.current = true;
    if (bridge || cancel || callbacks.current.readOnly) callbacks.current.onCancel();
    else {
      if (originalDoc.current && view.current!.state.doc.eq(originalDoc.current)) {
        callbacks.current.onCancel();
        return true;
      }
      const next = canvasTextValue(view.current!.state.doc, style);
      if (callbacks.current.onCommit(next.text, next.runs) === false) {
        completed.current = false;
        setError(
          '編集中に文字または書式が変更されました。入力をコピーしてキャンセルし、現在の内容を確認してください。',
        );
        return false;
      }
    }
    return true;
  };
  const inputs = useEditorInput({
    label: 'Canvas文字',
    read: () => ({
      dirty:
        !bridge &&
        !completed.current &&
        !!view.current &&
        !!originalDoc.current &&
        !view.current.state.doc.eq(originalDoc.current),
      composing: !!view.current?.composing,
    }),
    prepare: () => {
      if (callbacks.current.readOnly || callbacks.current.stale)
        throw new Error(
          '文字または書式が変更済み、または編集できません。入力を保持して現在値を確認してください。',
        );
      return () => finish();
    },
    focus: () => view.current?.focus(),
  });
  useEffect(() => {
    if (bridge || !privateInputs) return;
    const token = {};
    privateInputs.add(token);
    return () => {
      privateInputs.delete(token);
    };
  }, [bridge, privateInputs]);
  useEffect(() => {
    const editor = new EditorView(mount.current!, {
      state:
        bridge?.state ??
        EditorState.create({
          doc: canvasTextDocument(text, runs, style),
          plugins: [
            history(),
            keymap({
              'Mod-b': toggleMark(canvasTextSchema.marks.bold),
              'Mod-i': toggleMark(canvasTextSchema.marks.italic),
              'Mod-u': toggleMark(canvasTextSchema.marks.underline),
              'Mod-z': undo,
              'Mod-Shift-z': redo,
              'Mod-y': redo,
              'Mod-Home': (state, dispatch) => {
                dispatch?.(state.tr.setSelection(TextSelection.atStart(state.doc)));
                return true;
              },
              'Mod-End': (state, dispatch) => {
                dispatch?.(state.tr.setSelection(TextSelection.atEnd(state.doc)));
                return true;
              },
              'Mod-Enter': () => {
                finish();
                return true;
              },
              Escape: () => {
                finish(true);
                return true;
              },
            }),
            keymap(baseKeymap),
          ],
        }),
      editable: () => !callbacks.current.readOnly,
      markViews: {
        fontSize(mark) {
          // Scale the mark wrapper too: an unfitted ancestor would enlarge the line box,
          // even when the text inside has a fitted inline decoration.
          const dom = document.createElement('span');
          dom.style.fontSize = `max(8px, calc(var(--ep-canvas-text-scale, 1) * ${mark.attrs.value}px))`;
          return { dom, contentDOM: dom };
        },
      },
      decorations: (state) =>
        currentDrawing.current ? canvasTextLayout(state, currentDrawing.current).decorations : null,
      handleKeyDown(_view, event) {
        if (event.isComposing || _view.composing) return false;
        if (
          bridge &&
          !callbacks.current.readOnly &&
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          ['z', 'y'].includes(event.key.toLowerCase())
        ) {
          event.preventDefault();
          try {
            bridge.history(event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo');
          } catch (error) {
            setError(String(error));
          }
          return true;
        }
        if (
          bridge &&
          (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && event.key === 'Enter'))
        ) {
          finish();
          return true;
        }
        return false;
      },
      attributes: {
        role: 'textbox',
        'aria-label': 'Edit canvas text',
        'aria-multiline': 'true',
        spellcheck: 'false',
      },
      dispatchTransaction(tr) {
        if (tr.docChanged && callbacks.current.readOnly) return;
        if (bridge) {
          try {
            bridge.dispatch(tr);
            setError('');
          } catch (e) {
            setError(String(e));
          }
          editor.updateState(bridge.state);
        } else editor.updateState(editor.state.apply(tr));
        refresh((revision) => revision + 1);
        inputs?.changed();
        const { from, to, empty, $from } = editor.state.selection;
        setActive(
          Object.keys(marks).filter((name) =>
            empty
              ? !!canvasTextSchema.marks[name].isInSet(editor.state.storedMarks ?? $from.marks())
              : editor.state.doc.rangeHasMark(from, to, canvasTextSchema.marks[name]),
          ),
        );
      },
      handleDOMEvents: {
        compositionstart: () => {
          queueMicrotask(() => {
            refresh((revision) => revision + 1);
            inputs?.changed();
          });
          return false;
        },
        compositionend: () => {
          queueMicrotask(() => {
            refresh((revision) => revision + 1);
            inputs?.changed();
          });
          return false;
        },
        blur: (_, e) => {
          if (
            e.relatedTarget &&
            (root.current?.contains(e.relatedTarget as Node) ||
              tools.current?.contains(e.relatedTarget as Node))
          )
            return false;
          // Let ProseMirror flush pending DOM input before serializing the private edit buffer.
          queueMicrotask(() => {
            if (
              view.current &&
              !root.current?.contains(document.activeElement) &&
              !tools.current?.contains(document.activeElement)
            )
              finish();
          });
          return false;
        },
      },
    });
    view.current = editor;
    originalDoc.current = editor.state.doc;
    if (caret) {
      const position = editor.posAtCoords({ left: caret.x, top: caret.y });
      if (position)
        editor.dispatch(
          editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(position.pos))),
        );
    }
    editor.focus();
    refresh((revision) => revision + 1);
    const stop = bridge?.subscribe(() => {
      if (view.current && view.current.state !== bridge.state)
        view.current.updateState(bridge.state);
    });
    return () => {
      stop?.();
      view.current = undefined;
      editor.destroy();
    };
  }, []);
  useEffect(() => {
    view.current?.setProps({ editable: () => !readOnly });
  }, [readOnly]);
  useEffect(() => {
    view.current?.setProps({
      decorations: (state) =>
        currentDrawing.current ? canvasTextLayout(state, currentDrawing.current).decorations : null,
    });
  }, [drawing]);
  const format = (name: string, value?: string | number) => {
    const editor = view.current!;
    if (value === undefined)
      toggleMark(canvasTextSchema.marks[name])(editor.state, editor.dispatch);
    else {
      const { from, to, empty } = editor.state.selection,
        mark = canvasTextSchema.marks[name].create({ value });
      editor.dispatch(
        empty ? editor.state.tr.addStoredMark(mark) : editor.state.tr.addMark(from, to, mark),
      );
    }
    editor.focus();
  };
  const layout = drawing
    ? view.current
      ? canvasTextLayout(view.current.state, drawing).layout
      : layoutDrawingText(drawing)
    : undefined;
  const toolbar = (
    <div
      ref={tools}
      className="ep-inline-text-tools"
      role="toolbar"
      aria-label="Selected text formatting"
      style={
        toolsContainer && toolsPosition
          ? { position: 'absolute', left: toolsPosition.x, top: toolsPosition.y, zIndex: 10 }
          : undefined
      }
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's')
          event.stopPropagation();
      }}
    >
      {['bold', 'italic', 'underline', 'strike'].map((name) => (
        <button
          key={name}
          aria-label={`Selected text ${name}`}
          aria-pressed={active.includes(name)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => format(name)}
        >
          {{ bold: 'B', italic: 'I', underline: 'U', strike: 'S' }[name]}
        </button>
      ))}
      <input
        aria-label="Selected text color"
        type="color"
        defaultValue="#253044"
        onChange={(e) => format('color', e.target.value)}
      />
      <select
        aria-label="Selected text size"
        defaultValue=""
        onChange={(e) => format('fontSize', Number(e.target.value))}
      >
        <option value="" disabled>
          Size
        </option>
        {[12, 18, 24, 32, 48, 64].map((size) => (
          <option key={size}>{size}</option>
        ))}
      </select>
      {onExpand && (
        <button
          aria-label={expanded ? 'Return to in-place text editing' : 'Expand text editor'}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onExpand}
        >
          {expanded ? '↙' : '↗'}
        </button>
      )}
      <button onMouseDown={(e) => e.preventDefault()} onClick={() => finish()}>
        Done
      </button>
    </div>
  );
  return (
    <div
      ref={root}
      className="ep-canvas-text-editor"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') e.stopPropagation();
      }}
    >
      {error && <p role="alert">{error}</p>}
      {toolsContainer ? createPortal(toolbar, toolsContainer) : toolbar}
      <div
        ref={mount}
        style={
          {
            '--ep-canvas-text-scale':
              layout && drawing
                ? layout.fontSize /
                  (drawing.typography?.fontSize ?? (drawing.kind === 'text' ? 28 : 18))
                : 1,
            boxSizing: 'border-box',
            paddingTop: layout && drawing ? Math.max(0, layout.startY - drawing.bounds.y) : 4,
            paddingLeft: layout?.padding ?? 4,
            paddingRight: layout?.padding ?? 4,
            paddingBottom: layout?.padding ?? 4,
            fontSize: layout?.fontSize ?? style.fontSize ?? 28,
            fontFamily: style.fontFamily ?? 'Arial, sans-serif',
            // Inherited booleans are engine marks; unmarked text must stay unstyled.
            fontWeight: 400,
            fontStyle: 'normal',
            textDecoration: 'none',
            color: style.color ?? '#253044',
            lineHeight: style.lineHeight ?? 1.3,
            letterSpacing: style.letterSpacing ?? 0,
            textAlign: style.align ?? 'left',
          } as CSSProperties
        }
      />
    </div>
  );
}
