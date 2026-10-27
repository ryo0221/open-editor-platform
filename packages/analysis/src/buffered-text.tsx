import { useEffect, useRef, useState } from 'react';
import type { EditorInputBoundary } from '@editor-platform/editor-core';
/** Native typing/IME owns its buffer; only a successful commit enters Session history. */
export function BufferedText({
  label,
  value,
  multiline,
  register,
  commit,
  changed,
  onError,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  register?(b: EditorInputBoundary): () => void;
  commit(value: string): void;
  changed(id: string, dirty: boolean): void;
  onError(message: string): void;
}) {
  const [text, setText] = useState(value),
    state = useRef({ text: value, base: value, composing: false });
  const latest = useRef({ value, commit, changed, onError });
  latest.current = { value, commit, changed, onError };
  const element = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (state.current.text === state.current.base) {
      state.current.text = value;
      state.current.base = value;
      setText(value);
    }
  }, [value]);
  const boundary = useRef<EditorInputBoundary>({
    label,
    read: () => ({
      dirty: state.current.text !== state.current.base,
      composing: state.current.composing,
    }),
    prepare: () => {
      if (state.current.composing) throw Error('IME変換を確定してください。');
      if (state.current.text === state.current.base) return () => {};
      if (latest.current.value !== state.current.base)
        throw Error('入力中に値が変わりました。編集を取消して再入力してください。');
      const next = state.current.text;
      return () => {
        latest.current.commit(next);
        state.current.base = next;
        latest.current.changed(label, false);
      };
    },
    focus: () => element.current?.focus(),
  }).current;
  useEffect(() => {
    const release = register?.(boundary);
    return () => {
      release?.();
      latest.current.changed(label, false);
    };
  }, [register, boundary, label]);
  const props = {
    value: text,
    ref: (e: HTMLInputElement | HTMLTextAreaElement | null) => {
      element.current = e;
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      state.current.text = e.target.value;
      setText(e.target.value);
      latest.current.changed(label, e.target.value !== state.current.base);
    },
    onCompositionStart: () => {
      state.current.composing = true;
      latest.current.changed(label, true);
    },
    onCompositionEnd: () => {
      state.current.composing = false;
      latest.current.changed(label, state.current.text !== state.current.base);
    },
    onBlur: () => {
      if (state.current.composing) return;
      try {
        boundary.prepare()();
      } catch (e) {
        latest.current.onError(String(e));
      }
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' && !state.current.composing) {
        state.current.text = latest.current.value;
        state.current.base = latest.current.value;
        setText(latest.current.value);
        latest.current.changed(label, false);
        e.stopPropagation();
      }
    },
  };
  return (
    <label>
      {label}
      {multiline ? <textarea {...props} /> : <input {...props} />}
    </label>
  );
}
