import { createContext, useContext, useLayoutEffect, useRef } from 'react';
import { type EditorInputBoundary, type EditorInputs } from '@editor-platform/editor-core';
export const EditorInputsContext = createContext<EditorInputs | undefined>(undefined);
/** The Host declares each export it can capture, independently of encoder availability. */
export const EditorOfficeCapabilitiesContext = createContext<{
  pptx: boolean;
  docx: boolean;
  reason?: string;
}>({ pptx: false, docx: false, reason: 'HostはOffice出力を提供していません。' });
export const EditorHistoryContext = createContext<{ undo(): void; redo(): void } | undefined>(
  undefined,
);
/** Keep validation/commit callbacks current while retaining one stable boundary token. */
export function useEditorInput(boundary: EditorInputBoundary): EditorInputs | undefined {
  const registry = useContext(EditorInputsContext);
  const current = useRef(boundary);
  current.current = boundary;
  const { dirty, composing, canUndo, canRedo } = boundary.read();
  useLayoutEffect(
    () =>
      registry?.register({
        get label() {
          return current.current.label;
        },
        read: () => current.current.read(),
        prepare: () => current.current.prepare(),
        focus: () => current.current.focus(),
        history: (direction) => current.current.history?.(direction) ?? false,
      }),
    [registry],
  );
  useLayoutEffect(() => {
    registry?.changed();
  }, [registry, dirty, composing, canUndo, canRedo]);
  return registry;
}
