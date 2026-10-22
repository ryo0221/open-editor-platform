import { useEffect, useRef, useState } from 'react';
import type { AxisRange } from '@editor-platform/time-axis';
import type { OverlayRead, ScheduleReadPort, ScheduleSourceInfo } from './host';
import { overlayWindow } from './view-model';

export interface OverlayState {
  enabled: boolean;
  sources: ScheduleSourceInfo[];
  selected: string[];
  reads: OverlayRead[];
  loading: boolean;
  error?: string;
  /** Bumped by a change notice to read again. */
  revision: number;
}
const empty: OverlayState = {
  enabled: false,
  sources: [],
  selected: [],
  reads: [],
  loading: false,
  revision: 0,
};

/** Personal overlay: memory only, discarded on revocation or account change. Every request is
 * tied to a token, so a response that arrives after a switch is never shown. */
export function useOverlay(read: ScheduleReadPort | undefined, range: AxisRange) {
  const [state, setState] = useState<OverlayState>(empty);
  // A withdrawn or replaced port drops everything from the old connection before effects run.
  const [port, setPort] = useState(read);
  if (port !== read) {
    setPort(read);
    setState(empty);
  }
  const token = useRef(0);
  const sourcesToken = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const invalidate = () => {
    token.current++;
    controller.current?.abort();
    controller.current = undefined;
  };
  const listSources = async () => {
    if (!read) return;
    const mine = ++sourcesToken.current;
    try {
      const sources = await read.listSources(new AbortController().signal);
      if (mine !== sourcesToken.current) return;
      setState((s) => ({
        ...s,
        sources,
        selected: s.selected.filter((h) => sources.some((x) => x.handle === h)),
        error: undefined,
      }));
    } catch (error) {
      if (mine === sourcesToken.current)
        setState((s) => ({ ...s, error: (error as Error).message }));
    }
  };
  useEffect(
    () => () => {
      // Responses and source lists requested through the old port are never shown.
      invalidate();
      sourcesToken.current++;
    },
    [read],
  );
  useEffect(() => {
    if (!read?.watch) return;
    return read.watch((notice) => {
      invalidate();
      if (notice.kind === 'revoked') {
        sourcesToken.current++;
        // Drop everything bound to the old identity before asking again.
        setState((s) => ({ ...empty, enabled: s.enabled }));
        void listSources();
      } else setState((s) => ({ ...s, reads: [], revision: s.revision + 1 }));
    });
    // listSources only reads refs and the port.
  }, [read]);
  const { enabled, selected, revision } = state;
  const key = `${range.start}:${range.end}:${selected.join(',')}:${enabled}:${revision}`;
  useEffect(() => {
    invalidate();
    if (!read || !enabled || !selected.length) {
      setState((s) => (s.reads.length || s.loading ? { ...s, reads: [], loading: false } : s));
      return;
    }
    const mine = token.current;
    const request = new AbortController();
    controller.current = request;
    setState((s) => ({ ...s, reads: [], loading: true, error: undefined }));
    const span = overlayWindow(range);
    void Promise.allSettled(
      selected.map((sourceHandle) => read.readRange({ sourceHandle, range: span }, request.signal)),
    ).then((results) => {
      if (mine !== token.current) return;
      // A failed calendar keeps the others; its whole range is unknown, not free.
      const reads = results.map(
        (r, i): OverlayRead =>
          r.status === 'fulfilled'
            ? r.value
            : {
                sourceHandle: selected[i],
                generation: '',
                range: span,
                complete: false,
                missing: [span],
                fetchedAt: Date.now(),
                events: [],
              },
      );
      const errors = results.flatMap((r) =>
        r.status === 'rejected' ? [(r.reason as Error).message] : [],
      );
      setState((s) => ({
        ...s,
        reads,
        loading: false,
        error: errors.length ? [...new Set(errors)].join(' ') : undefined,
      }));
    });
    return () => request.abort();
    // The key captures range, selection and enabled state.
  }, [read, key]);
  return {
    state,
    toggle() {
      if (state.enabled) {
        invalidate();
        sourcesToken.current++;
        setState(empty);
      } else {
        setState({ ...empty, enabled: true });
        void listSources();
      }
    },
    choose(handle: string, on: boolean) {
      setState((s) => ({
        ...s,
        selected: on
          ? [...new Set([...s.selected, handle])]
          : s.selected.filter((h) => h !== handle),
      }));
    },
  };
}
