/** Approved bounded Surface facade experiment; does not change draft.2 Context. */
import type { EditorCommand, LocalDraftRevision } from '@editor-platform/editor-core';
import type { LocalReadSnapshot, SaveOutcome } from './draft2';
export const CONTROLLED_SURFACE_VERSION = 'controlled-surface@0-experiment' as const;
export type SurfaceOperation =
  | { state: 'applied' | 'unchanged' }
  | { state: 'refused'; code: string; message: string };
export interface PreparedSurfaceCommand<T> {
  readonly baseRevision: Readonly<LocalDraftRevision>;
  /** One aggregate command. Null means validated canonical no-op, preserving Redo. */
  readonly command: EditorCommand<T> | null;
}
export interface AtomicSurfaceInputs<T> {
  readonly label: string;
  read(): { dirty: boolean; composing: boolean };
  /** Pure preparation: all owned buffers together, child expected snapshots chained.
   * Compare buffer base to snapshot.revision; never silently rebase/clear dirty input. */
  prepare(snapshot: LocalReadSnapshot<T>): PreparedSurfaceCommand<T>;
  /** Called only after successful aggregate commit/no-op, before publishing its view. */
  committed(snapshot: LocalReadSnapshot<T>): void;
  focus(): void;
}
export type SurfaceSaveResult =
  | { state: 'outcome'; outcome: SaveOutcome }
  | { state: 'refused'; code: string; message: string };
export type ControlledSurfaceSnapshot<T> =
  | {
      state: 'open';
      snapshot: LocalReadSnapshot<T>;
      canEdit: boolean; // edit + inputs + lifecycle, not canUndo/canRedo.
      canSave: boolean;
      saving: boolean;
      lastOperation?: SurfaceOperation;
      lastSave?: SaveOutcome;
    }
  | { state: 'revoked'; code: 'ScopeRevoked' };
export interface ControlledSurfaceController<T> {
  readonly version: typeof CONTROLLED_SURFACE_VERSION;
  /** Stable cached view, suitable for useSyncExternalStore. No external/live-follow promise. */
  getSnapshot(): ControlledSurfaceSnapshot<T>;
  /** Own scoped operations/save/revoke only; not a new Basic/session subscription API. */
  subscribe(listener: () => void): () => void;
  /** UI and non-UI callers share this authority/stale/input boundary. */
  execute(prepared: PreparedSurfaceCommand<T>): SurfaceOperation;
  applyInputs(): SurfaceOperation;
  undo(): SurfaceOperation;
  redo(): SurfaceOperation;
  save(): Promise<SurfaceSaveResult>;
  /** Exactly one aggregate group per mounted Surface. Missing Inputs => read-only. */
  bindInputs(group: AtomicSurfaceInputs<T>): { changed(): void; unregister(): void };
}
