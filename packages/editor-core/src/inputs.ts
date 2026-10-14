/** Private input buffers are owned by their Surface, never by the native document. */
export interface EditorInputBoundary {
  label: string;
  read(): { dirty: boolean; composing?: boolean; canUndo?: boolean; canRedo?: boolean };
  /** Validate without changing content; the returned function commits through the Host. */
  prepare(): () => void | boolean;
  focus(): void;
  /** Optional private draft history, e.g. an unsaved Data view. Return false to use native history. */
  history?(direction: 'undo' | 'redo'): boolean;
}
export interface EditorInputSnapshot {
  dirty: number;
  composing: number;
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
    canUndo: false,
    canRedo: false,
  };
  register(boundary: EditorInputBoundary): () => void {
    this.boundaries.add(boundary);
    this.changed();
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
    const dirty = values.filter((value) => value.dirty).length;
    const composing = values.filter((value) => value.composing).length;
    const canUndo = values.some((value) => value.canUndo);
    const canRedo = values.some((value) => value.canRedo);
    if (
      dirty === this.snapshot.dirty &&
      composing === this.snapshot.composing &&
      canUndo === this.snapshot.canUndo &&
      canRedo === this.snapshot.canRedo
    )
      return;
    this.snapshot = { dirty, composing, canUndo, canRedo };
    this.listeners.forEach((listener) => listener());
  };
  flush(): void {
    const prepared: { boundary: EditorInputBoundary; commit: () => void | boolean }[] = [];
    // All buffers must pass preflight before the first canonical command is submitted.
    for (const boundary of this.boundaries) {
      const state = boundary.read();
      if (!state.dirty && !state.composing) continue;
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
    this.changed();
  }
}
