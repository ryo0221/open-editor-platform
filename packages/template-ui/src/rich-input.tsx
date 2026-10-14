import { useEffect, useRef, useState } from 'react';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { baseKeymap, toggleMark } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import { history, undo, redo } from 'prosemirror-history';
import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { documentSchema, inlineNodes, spansFromNode } from '@editor-platform/document/engine';
import type { InlineSpan } from '@editor-platform/document/model';
import type { InputValue } from '@editor-platform/templates';
import { canonicalJson } from '@editor-platform/artifact-core';

const fromValue = (value: InputValue | undefined) =>
  documentSchema.nodes.doc.create(
    null,
    documentSchema.nodes.paragraph.create(
      null,
      inlineNodes(
        (Array.isArray(value)
          ? value.filter(
              (span) =>
                span && typeof span === 'object' && 'text' in span && typeof span.text === 'string',
            )
          : [{ text: String(value ?? '') }]) as InlineSpan[],
      ),
    ),
  );
function spans(doc: PMNode) {
  const result: InlineSpan[] = [];
  doc.descendants((node) => {
    if (!node.isTextblock) return;
    if (result.length) result.push({ text: '\n' });
    result.push(...spansFromNode(node));
    return false;
  });
  return result;
}
/** The native Document text engine edits the public inline-span contract in a private form. */
export function TemplateRichInput(props: {
  id: string;
  path: string;
  label: string;
  value: InputValue | undefined;
  invalid: boolean;
  onChange(value: InputValue): void;
}) {
  const mount = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | undefined>(undefined);
  const latest = useRef(props);
  latest.current = props;
  const [active, setActive] = useState<string[]>([]);
  const [composing, setComposing] = useState(false);
  useEffect(() => {
    const editor = new EditorView(mount.current!, {
      state: EditorState.create({
        doc: fromValue(latest.current.value),
        plugins: [
          history(),
          keymap({
            'Mod-b': toggleMark(documentSchema.marks.bold),
            'Mod-i': toggleMark(documentSchema.marks.italic),
            'Mod-u': toggleMark(documentSchema.marks.underline),
            'Mod-z': undo,
            'Mod-Shift-z': redo,
            'Mod-y': redo,
            Enter: (state, dispatch) => {
              dispatch?.(
                state.tr
                  .replaceSelectionWith(documentSchema.nodes.hard_break.create())
                  .scrollIntoView(),
              );
              return true;
            },
          }),
          keymap(baseKeymap),
        ],
      }),
      attributes: {
        role: 'textbox',
        'aria-label': props.label,
        'aria-multiline': 'true',
        'data-slot': props.path,
        id: props.id,
      },
      dispatchTransaction(tr) {
        editor.updateState(editor.state.apply(tr));
        const { from, to, empty, $from } = editor.state.selection;
        setActive(
          ['bold', 'italic', 'underline', 'strike'].filter((name) =>
            empty
              ? !!documentSchema.marks[name].isInSet(editor.state.storedMarks ?? $from.marks())
              : editor.state.doc.rangeHasMark(from, to, documentSchema.marks[name]),
          ),
        );
        if (tr.docChanged)
          latest.current.onChange(spans(editor.state.doc) as unknown as InputValue);
      },
      transformPasted(slice) {
        if (slice.content.firstChild?.isInline) return slice;
        const native = documentSchema.nodes.doc.create(null, slice.content);
        return new Slice(Fragment.from(inlineNodes(spans(native))), 0, 0);
      },
      handleDOMEvents: {
        compositionstart: () => {
          setComposing(true);
          return false;
        },
        compositionend: () => {
          setComposing(false);
          return false;
        },
      },
    });
    view.current = editor;
    return () => {
      view.current = undefined;
      editor.destroy();
    };
  }, []);
  useEffect(() => {
    const editor = view.current;
    if (
      !editor ||
      editor.composing ||
      canonicalJson(spans(editor.state.doc)) === canonicalJson(props.value)
    )
      return;
    const next = fromValue(props.value);
    if (!editor.state.doc.eq(next)) {
      const tr = editor.state.tr
        .replaceWith(0, editor.state.doc.content.size, next.content)
        .setMeta('addToHistory', false);
      editor.updateState(editor.state.apply(tr));
    }
  }, [props.value]);
  useEffect(() => {
    view.current?.setProps({
      attributes: {
        role: 'textbox',
        'aria-label': props.label,
        'aria-multiline': 'true',
        'aria-invalid': String(props.invalid),
        'data-slot': props.path,
        id: props.id,
      },
    });
  }, [props.id, props.label, props.path, props.invalid]);
  const format = (name: string, value?: string) => {
    const editor = view.current;
    if (!editor || editor.composing) return;
    if (value === undefined) toggleMark(documentSchema.marks[name])(editor.state, editor.dispatch);
    else {
      const { from, to, empty } = editor.state.selection,
        mark = documentSchema.marks[name].create({ value });
      editor.dispatch(
        empty ? editor.state.tr.addStoredMark(mark) : editor.state.tr.addMark(from, to, mark),
      );
    }
    editor.focus();
  };
  return (
    <div className="tp-rich-input" onKeyDown={(e) => e.stopPropagation()}>
      <div role="toolbar" aria-label={`${props.label}の文字書式`}>
        {(['bold', 'italic', 'underline', 'strike'] as const).map((name) => (
          <button
            type="button"
            key={name}
            aria-label={
              { bold: '太字', italic: '斜体', underline: '下線', strike: '取り消し線' }[name]
            }
            aria-pressed={active.includes(name)}
            disabled={composing}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => format(name)}
          >
            {{ bold: 'B', italic: 'I', underline: 'U', strike: 'S' }[name]}
          </button>
        ))}
        <input
          type="color"
          aria-label={`${props.label}の文字色`}
          defaultValue="#336699"
          disabled={composing}
          onChange={(e) => format('color', e.target.value)}
        />
      </div>
      <div ref={mount} />
      {composing && <small role="status">文字を変換中です。</small>}
    </div>
  );
}
