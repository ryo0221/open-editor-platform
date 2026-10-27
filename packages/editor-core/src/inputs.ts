/** Private input buffers are owned by their Surface, never by the native document. */
export interface EditorInputBoundary {
  label: string;
  /**
   * `settles` marks pending work that applies by itself and never mixes into the content until it
   * does (e.g. a CAD edit still evaluating): a save that keeps the editor open may capture the
   * content without it, while leaving the editor still waits for it.
   */
  read(): {
    dirty: boolean;
    composing?: boolean;
    settles?: boolean;
    canUndo?: boolean;
    canRedo?: boolean;
  };
  /** Validate without changing content; the returned function commits through the Host. */
  prepare(): () => void | boolean;
  focus(): void;
  /** Optional private draft history, e.g. an unsaved Data view. Return false to use native history. */
  history?(direction: 'undo' | 'redo'): boolean;
}
export interface EditorInputSnapshot {
  /** Inputs not yet in the content; pending work that settles by itself is counted apart. */
  dirty: number;
  composing: number;
  settling: number;
  canUndo: boolean;
  canRedo: boolean;
}
export class EditorInputError extends Error {}
/** A save/export/switch boundary shared by independent Hosts and ordinary Surfaces. */
export class EditorInputs {
  private boundaries = new Set<EditorInputBoundary>();
  private listeners = new Set<() => void>();
  private snapshot: EditorInputSnapshot = {
    dirty: 0,
    composing: 0,
    settling: 0,
    canUndo: false,
    canRedo: false,
  };
  register(boundary: EditorInputBoundary): () => void {
    this.boundaries.add(boundary);
    try {
      this.changed();
    } catch (error) {
      // A synchronous notification must not strand a boundary whose disposer
      // could not be returned to the caller.
      this.boundaries.delete(boundary);
      try {
        this.changed();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Input registration rollback notification failed',
        );
      }
      throw error;
    }
    return () => {
      this.boundaries.delete(boundary);
      this.changed();
    };
  }
  getSnapshot = (): EditorInputSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  history(direction: 'undo' | 'redo'): boolean {
    for (const boundary of [...this.boundaries].reverse())
      if (boundary.history?.(direction)) {
        this.changed();
        return true;
      }
    return false;
  }
  changed = (): void => {
    const values = [...this.boundaries].map((boundary) => boundary.read());
    const dirty = values.filter((value) => value.dirty && !value.settles).length;
    const composing = values.filter((value) => value.composing).length;
    const settling = values.filter((value) => value.dirty && value.settles).length;
    const canUndo = values.some((value) => value.canUndo);
    const canRedo = values.some((value) => value.canRedo);
    if (
      dirty === this.snapshot.dirty &&
      composing === this.snapshot.composing &&
      settling === this.snapshot.settling &&
      canUndo === this.snapshot.canUndo &&
      canRedo === this.snapshot.canRedo
    )
      return;
    this.snapshot = { dirty, composing, settling, canUndo, canRedo };
    this.listeners.forEach((listener) => listener());
  };
  /**
   * Commits every buffered input. `keepEditor` is for a save that leaves the editor open (a
   * version save, a draft save): it captures the committed content and lets settling work finish
   * afterwards instead of refusing.
   */
  flush(options: { keepEditor?: boolean } = {}): void {
    const prepared: { boundary: EditorInputBoundary; commit: () => void | boolean }[] = [];
    // Settling work that was already pending; anything that starts settling below was started by
    // this flush's own commits (e.g. a field whose value starts an evaluation).
    const settling = new Set<EditorInputBoundary>();
    // All buffers must pass preflight before the first canonical command is submitted.
    for (const boundary of this.boundaries) {
      const state = boundary.read();
      if (state.dirty && state.settles) settling.add(boundary);
      if (!state.dirty && !state.composing) continue;
      if (options.keepEditor && state.settles && !state.composing) continue;
      try {
        if (state.composing)
          throw new EditorInputError('日本語などの入力変換を確定してから保存してください。');
        prepared.push({ boundary, commit: boundary.prepare() });
      } catch (error) {
        boundary.focus();
        throw new EditorInputError(
          `${boundary.label}: ${String(error instanceof Error ? error.message : error)}`,
        );
      }
    }
    for (const { boundary, commit } of prepared) {
      try {
        if (commit() === false)
          throw new EditorInputError('変更を確定できません。入力を確認してください。');
      } catch (error) {
        boundary.focus();
        throw new EditorInputError(
          `${boundary.label}: ${String(error instanceof Error ? error.message : error)}`,
        );
      }
    }
    // A save that keeps the editor open may leave out only work that was pending before it: what
    // its own commits started is the user's latest input, so that save waits for it.
    if (options.keepEditor)
      for (const boundary of this.boundaries) {
        const state = boundary.read();
        if (!state.dirty || !state.settles || settling.has(boundary)) continue;
        this.changed();
        let message = '入力の反映が終わってから、もう一度操作してください。';
        try {
          boundary.prepare();
        } catch (error) {
          message = String(error instanceof Error ? error.message : error);
        }
        throw new EditorInputError(`${boundary.label}: ${message}`);
      }
    this.changed();
  }
}
