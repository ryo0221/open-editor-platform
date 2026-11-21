import type { MutableRefObject } from 'react';
import type { ReferenceResolver } from '@editor-platform/artifact-references';
import type { SharedEditorSession } from '@editor-platform/collaboration-adapters';
import type { Preview } from '@editor-platform/collaboration-core';
import type {
  EditorCommand,
  EditorInputs,
  EditorSession,
  ElementAddress,
  ProposedCommands,
  Region,
  Selection,
} from '@editor-platform/editor-core';
import type { ReviewVisibleSource } from '@editor-platform/review-surfaces';
import type { DataView } from '@editor-platform/structured-data';
import type { InputValue, PrivateViewSettings } from '@editor-platform/templates';
import type { savedAnimationCatalog } from '../animation-library';
import type { Content, StoredArtifact } from '../model';

type SurfaceExecute = <T extends Content>(cmd: EditorCommand<T>) => boolean;
type SurfaceSelect = (ids: string | string[], region?: Region, pageId?: string) => void;

/** Playground Host state and actions each native surface binds to. */
export interface SurfaceHost {
  active: StoredArtifact;
  records: StoredArtifact[];
  recordsRef: MutableRefObject<StoredArtifact[]>;
  savedRecords: MutableRefObject<Map<string, StoredArtifact>>;
  sessions: MutableRefObject<Map<string, EditorSession<Content>>>;
  session: EditorSession<Content> | SharedEditorSession<Content> | undefined;
  sharedSession: SharedEditorSession<Content> | undefined;
  /** Shared connections render graphs without the local data-graph bridge. */
  shared: boolean;
  sharedPreview: { id: string; preview: Preview<Content> } | undefined;
  inputs: EditorInputs;
  readOnly: boolean;
  busy: boolean;
  selection: Selection;
  revealAddress: ElementAddress | undefined;
  references: ReferenceResolver;
  loadErrors: Record<string, string>;
  animationCatalog: ReturnType<typeof savedAnimationCatalog>;
  dataViews: Record<string, DataView>;
  templateViewSettings: Record<string, Record<string, InputValue>>;
  visibleReviewSource: MutableRefObject<
    { artifactId: string; source: ReviewVisibleSource } | undefined
  >;
  referenceNavigation: MutableRefObject<
    (sourceId: string, elementId: string, pageId?: string) => boolean
  >;
  whiteboardLayout: { viewKey: string };
  canvasText: ((id: string) => ReturnType<SharedEditorSession<Content>['text']>) | undefined;
  exportGuard: (() => void) | undefined;
  previewBlocked: boolean;
  execute: SurfaceExecute;
  select: SurfaceSelect;
  /** The current-render select, used where the surface clears selection directly. */
  selectNow: SurfaceSelect;
  persist(record: StoredArtifact): unknown;
  activate(id: string): void;
  flushInputs(): boolean;
  history(direction: 'undo' | 'redo'): void;
  saveVersion(): Promise<void>;
  /** Shows Host-built commands in the proposal review; the author applies or rejects them. */
  reviewProposal(value: ProposedCommands<Content>): void;
  addComment(selection: Selection, body: string): Promise<boolean | undefined>;
  dataViewChanged(view: DataView): void;
  editPrivateSettings(id: string, patch: PrivateViewSettings): void;
  setRevealAddress(address: ElementAddress): void;
  setError(message: string): void;
  setStatus(message: string): void;
}

/** The latest stored record of the active (or the named) Artifact. */
export function latestRecord(host: SurfaceHost, id = host.active.id) {
  return host.recordsRef.current.find((record) => record.id === id);
}
