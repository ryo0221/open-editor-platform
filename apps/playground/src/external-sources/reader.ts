/** Editor-side reactions to an external read port, shared by the Geo, Data and work item panels
 * of the reference Host. Memory only: nothing read here is saved, and a request is tied to a
 * token so a response from before a change, a revocation or a newer read is never shown. */
export interface SourceNotice {
  kind: 'changed' | 'revoked';
  sourceHandle?: string;
}
export interface SourcePort<S extends { handle: string }, R> {
  listSources(signal: AbortSignal): Promise<S[]>;
  read(sourceHandle: string, signal: AbortSignal): Promise<R>;
  watch?(notify: (notice: SourceNotice) => void): () => void;
}
export interface SourceReadState<S, R> {
  sources: S[];
  selected?: string;
  status: 'idle' | 'loading' | 'ready' | 'failed';
  read?: R;
  /** Why nothing is shown, or what the last notice did. Plain text. */
  message?: string;
}

export function createSourceReader<S extends { handle: string }, R>(
  port: SourcePort<S, R>,
  onChange: (state: SourceReadState<S, R>) => void,
) {
  let state: SourceReadState<S, R> = { sources: [], status: 'idle' };
  let token = 0,
    sourcesToken = 0,
    controller: AbortController | undefined;
  const set = (next: Partial<SourceReadState<S, R>>) => {
    state = { ...state, ...next };
    onChange(state);
  };
  const invalidate = () => {
    token++;
    controller?.abort();
    controller = undefined;
  };
  async function listSources() {
    const mine = ++sourcesToken;
    try {
      const sources = await port.listSources(new AbortController().signal);
      if (mine !== sourcesToken) return;
      const selected = sources.some((s) => s.handle === state.selected)
        ? state.selected
        : sources[0]?.handle;
      set({ sources, selected });
    } catch (error) {
      if (mine === sourcesToken) set({ status: 'failed', message: (error as Error).message });
    }
  }
  async function read(message?: string) {
    invalidate();
    const sourceHandle = state.selected;
    if (!sourceHandle) return;
    const mine = token;
    const request = new AbortController();
    controller = request;
    // The previous result is not kept on screen as if it were current.
    set({ status: 'loading', read: undefined, message });
    try {
      const value = await port.read(sourceHandle, request.signal);
      if (mine === token) set({ status: 'ready', read: value });
    } catch (error) {
      if (mine === token) set({ status: 'failed', message: (error as Error).message });
    }
  }
  const stop = port.watch?.((notice) => {
    if (notice.kind === 'revoked') {
      invalidate();
      sourcesToken++;
      // Everything bound to the old identity goes before asking again.
      set({
        sources: [],
        selected: undefined,
        status: 'idle',
        read: undefined,
        message: 'The connection changed. Results from the old connection were discarded.',
      });
      void listSources();
    } else if (!notice.sourceHandle || notice.sourceHandle === state.selected) {
      const wasShown = state.status !== 'idle';
      invalidate();
      if (wasShown) void read('The source changed. Read again.');
      else set({ read: undefined, message: 'The source changed.' });
    }
  });
  void listSources();
  return {
    state: () => state,
    select(handle: string) {
      invalidate();
      set({ selected: handle, status: 'idle', read: undefined, message: undefined });
    },
    read: () => read(),
    dispose() {
      invalidate();
      sourcesToken++;
      stop?.();
    },
  };
}
