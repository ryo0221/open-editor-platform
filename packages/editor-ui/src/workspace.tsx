import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import type { EditorInputs } from '@editor-platform/editor-core';

export interface EditorWorkspaceTransition<T extends string> {
  requested: T;
  displayed: T;
  state: 'applied' | 'pending';
  reason?: string;
}
export interface EditorWorkspaceProps<T extends string> {
  /** Controlled workspace. Omitted: the Surface keeps its own choice, starting from the base. */
  workspace?: T;
  onWorkspaceRequest?(workspace: T): void;
  onWorkspaceTransition?(transition: EditorWorkspaceTransition<T>): void;
}
export interface EditorWorkspaceOptions {
  /** Pointer drags that start inside this selector hold a transition until they end. */
  pointerSelector?: string;
}
const empty: Pick<ReturnType<EditorInputs['getSnapshot']>, 'composing'> = { composing: 0 };
const noInputs = {
  subscribe: () => () => {},
  getSnapshot: () => empty,
};

/** View-only workspace transition shared by Editors that offer a dedicated screen over the same
 * native content. A request stays pending while an IME composition or a tracked drag is active,
 * then flushes uncommitted inputs before the displayed workspace changes. Nothing here touches
 * content, drafts or history; owners stay mounted while a transition is pending. */
export function useEditorWorkspace<T extends string>(
  base: T,
  props: EditorWorkspaceProps<T>,
  inputs: EditorInputs | undefined,
  options: EditorWorkspaceOptions = {},
) {
  const [local, setLocal] = useState<T>(base);
  const [displayed, setDisplayed] = useState<T>(props.workspace ?? base);
  const requested = props.workspace ?? local;
  const source = inputs ?? noInputs;
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const pointers = useRef(new Set<number>()),
    [pointerCount, setPointerCount] = useState(0);
  const [composing, setComposing] = useState(false);
  const [reason, setReason] = useState('');
  const flushing = useRef(false);
  useEffect(() => {
    if (requested === displayed) {
      setReason('');
      return;
    }
    if (pointerCount || snapshot.composing || composing) {
      setReason('入力・ドラッグの完了を待っています');
      return;
    }
    if (flushing.current) return;
    flushing.current = true;
    try {
      inputs?.flush();
      setDisplayed(requested);
      setReason('');
    } catch (error) {
      setReason(error instanceof Error ? error.message : String(error));
    } finally {
      flushing.current = false;
    }
  }, [requested, displayed, pointerCount, snapshot, composing, inputs]);
  const notify = useRef(props.onWorkspaceTransition);
  notify.current = props.onWorkspaceTransition;
  useEffect(() => {
    notify.current?.({
      requested,
      displayed,
      state: requested === displayed ? 'applied' : 'pending',
      ...(reason ? { reason } : {}),
    });
  }, [requested, displayed, reason]);
  const request = (next: T) => {
    if (props.workspace === undefined) setLocal(next);
    props.onWorkspaceRequest?.(next);
  };
  const end = (event: PointerEvent) => {
    pointers.current.delete(event.pointerId);
    setPointerCount(pointers.current.size);
  };
  return {
    displayed,
    requested,
    pending: requested !== displayed,
    reason,
    request,
    events: {
      onPointerDownCapture: (event: PointerEvent) => {
        if (
          options.pointerSelector &&
          event.target instanceof Element &&
          event.target.closest(options.pointerSelector)
        ) {
          pointers.current.add(event.pointerId);
          setPointerCount(pointers.current.size);
        }
      },
      onPointerUpCapture: end,
      onPointerCancelCapture: end,
      onLostPointerCaptureCapture: end,
      onCompositionStartCapture: () => setComposing(true),
      onCompositionEndCapture: () => setComposing(false),
      onKeyUpCapture: (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          pointers.current.clear();
          setPointerCount(0);
        }
      },
    },
  };
}
