import { useRef, type HTMLAttributes } from 'react';
import type { EditorInputs } from '@editor-platform/editor-core';

export function useSlideInputGuard(inputs: EditorInputs | undefined) {
  const composing = useRef(false);
  const composingAtPress = useRef(false);
  const isComposing = () => composing.current || !!inputs?.getSnapshot().composing;
  const events: HTMLAttributes<HTMLDivElement> = {
    onCompositionStartCapture: () => {
      composing.current = true;
    },
    onCompositionEndCapture: () => {
      composing.current = false;
    },
    onPointerDownCapture: () => {
      composingAtPress.current = isComposing();
    },
    onPointerCancelCapture: () => {
      composingAtPress.current = false;
    },
    onClickCapture: (event) => {
      const blocked = isComposing() || (event.detail !== 0 && composingAtPress.current);
      composingAtPress.current = false;
      if (
        blocked &&
        event.target instanceof Element &&
        !event.target.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onKeyDownCapture: (event) => {
      if (isComposing() || event.nativeEvent.isComposing || event.keyCode === 229) {
        if (
          event.key === 'Escape' &&
          event.target instanceof Element &&
          event.target.closest('dialog')
        ) {
          event.preventDefault();
        }
        event.stopPropagation();
      }
    },
    onSubmitCapture: (event) => {
      if (isComposing()) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
  return { events, isComposing };
}
