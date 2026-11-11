import { useEffect, useRef } from 'react';

/** A consuming router observes this state; it never owns native inputs, history or saving. */
export interface CreativeNavigationState {
  dirty: boolean;
  busy: boolean;
}
export function useCreativeNavigationState(
  state: CreativeNavigationState,
  notify?: (state: CreativeNavigationState) => void,
) {
  const callback = useRef(notify);
  callback.current = notify;
  const listening = !!notify;
  useEffect(() => {
    callback.current?.({ dirty: state.dirty, busy: state.busy });
  }, [state.dirty, state.busy, listening]);
  useEffect(() => () => callback.current?.({ dirty: false, busy: false }), []);
}
