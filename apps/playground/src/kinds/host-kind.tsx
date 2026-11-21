import type { ComponentType, ReactNode } from 'react';
import type { KindDefinition } from '@editor-platform/artifact-kinds';
import type { EditorInputs, EditorSession } from '@editor-platform/editor-core';
import type { Content, StoredArtifact } from '../model';
import { pairKinds } from './pair-kinds';
import type { SurfaceHost } from './surface-host';

/** What the Playground passes to a kind's Surface: its Host state and the checked content. */
export interface HostSurfaceProps<C> {
  host: SurfaceHost;
  content: C;
}

/** The content type of a typed definition. */
export type KindContent<D> = D extends KindDefinition<infer C> ? C : never;

/** The Playground's parts for one kind (docs/kind-registry-design.md, 「Hostごとの描画と接続」). */
export interface HostKindParts<C> {
  /**
   * The Surface. Engineering Surfaces wrap a `lazy()` Host and its Suspense fallback, so their
   * code loads only when such an Artifact opens; office Surfaces load with the Playground.
   */
  Surface: ComponentType<HostSurfaceProps<C>>;
  /**
   * Which editor session the Surface needs: `local` renders only with a local session (not in
   * a shared connection), `any` with either. Absent, the Surface renders for any valid content.
   */
  session?: 'local' | 'any';
  /** A further check on top of the kind's `validate`, for Surfaces that read only the current schema. */
  accepts?(content: C): boolean;
  /** The React key; a new key remounts the Surface. Absent, the active Artifact's id. */
  surfaceKey?(host: SurfaceHost): string;
  /** Playground behaviour beyond the Surface. */
  hooks?: HostKindHooks<C>;
}

/** What a kind's Undo/Redo step sees (local sessions only; shared sessions step on the server). */
export interface HistoryContext {
  session: EditorSession<Content>;
  direction: 'undo' | 'redo';
  /** The latest stored record of the Artifact. */
  record: StoredArtifact;
  pending: ReturnType<EditorInputs['getSnapshot']>;
  /** Whether the Artifact is still the writable active one (checked while a step runs). */
  canEdit(): boolean;
}

/** The result of a kind's Undo/Redo: new content, a refusal shown as the error, or nothing. */
export type HistoryStep<C> = { content: C } | { refused: string } | { unchanged: true };

/**
 * Playground behaviour of a kind beyond its Surface, so App.tsx needs no per-kind branch.
 * Every hook is optional; absent, the Playground's ordinary behaviour applies.
 */
export interface HostKindHooks<C> {
  /** Edits and Undo/Redo wait while a version is saved (Animation). */
  holdsEditsWhileSaving?: boolean;
  /**
   * Pending Host inputs (dirty or composing) refuse Undo/Redo with this message, before the
   * inputs' own history runs. `disablesHistory` also disables the Undo/Redo buttons meanwhile.
   */
  pendingInputs?: { refusal: string; disablesHistory?: boolean };
  /** Undo/Redo of the local session, when it is not the session's plain step. */
  history?(context: HistoryContext): HistoryStep<C>;
  /** The content a saved version restores to the draft: checked, and read as the current schema. */
  restore?(record: StoredArtifact, content: C): C;
  /** Checks before a version is committed; a throw keeps the draft and shows the error. */
  beforeVersion?(record: StoredArtifact): Promise<void>;
  /** Versions always capture with strict identity checks (Geo resources). */
  strictCapture?: boolean;
  /** The comment inspector beside the Surface. Absent, it is shown. */
  comments?: false;
  /** Switching to read-only commits the Surface's text inputs first. */
  flushBeforeReadOnly?: boolean;
  /** Content upgraded when a stored record opens is adopted by its draft (older Graph schemas). */
  adoptsOpenedContent?: boolean;
  /** Whether native reuse (reusable fragments) applies to this content. Absent, it does. */
  nativeReuse?(content: C): boolean;
  /** The export menu's extra entries for this content. */
  exports?: { documentText?: boolean; csv?: boolean; download?(content: C): void };
  /** Saving this kind's records changes the saved Animation catalog. */
  feedsAnimationCatalog?: boolean;
  /** The Surface reads the saved Animation catalog (it is built only for such a kind). */
  readsAnimationCatalog?: boolean;
  /** The kind cannot open in a shared (collaborative) session. */
  sharedSessions?: false;
  /** Shared-session annotations address the Surface's own regions (Review, File). */
  annotationSurface?: boolean;
  /** The toolbar's Comments button is hidden, or shown but disabled. Absent, it works. */
  commentsButton?: 'hidden' | 'disabled';
}

/** The hooks with the content type erased; content reaches them only after `validate`. */
export interface KindHooks {
  holdsEditsWhileSaving: boolean;
  pendingInputs?: { refusal: string; disablesHistory?: boolean };
  history?(context: HistoryContext): HistoryStep<Content>;
  restore?(record: StoredArtifact, content: unknown): Content;
  beforeVersion?(record: StoredArtifact): Promise<void>;
  strictCapture: boolean;
  comments: boolean;
  flushBeforeReadOnly: boolean;
  adoptsOpenedContent: boolean;
  nativeReuse(content: unknown): boolean;
  exports: { documentText: boolean; csv: boolean; download?(content: unknown): void };
  feedsAnimationCatalog: boolean;
  readsAnimationCatalog: boolean;
  sharedSessions: boolean;
  annotationSurface: boolean;
  commentsButton?: 'hidden' | 'disabled';
}

/** The ordinary Playground behaviour, for a kind without hooks or a kind this Host does not know. */
export const ordinaryHooks: KindHooks = Object.freeze({
  holdsEditsWhileSaving: false,
  strictCapture: false,
  comments: true,
  flushBeforeReadOnly: false,
  adoptsOpenedContent: false,
  nativeReuse: () => true,
  exports: Object.freeze({ documentText: false, csv: false }),
  feedsAnimationCatalog: false,
  readsAnimationCatalog: false,
  sharedSessions: true,
  annotationSurface: false,
});

function eraseHooks<C>(definition: KindDefinition<C>, hooks: HostKindHooks<C> = {}): KindHooks {
  const { history, restore, nativeReuse, exports } = hooks;
  const download = exports?.download;
  const checked = (content: unknown, what: string) => {
    if (!definition.validate(content)) throw new Error(`${definition.kind}: ${what} is not valid`);
    return content;
  };
  const erased: KindHooks = {
    ...ordinaryHooks,
    holdsEditsWhileSaving: !!hooks.holdsEditsWhileSaving,
    pendingInputs: hooks.pendingInputs,
    history: history && ((context) => history(context) as HistoryStep<Content>),
    // A saved version restores as it was stored; the kind's hook checks or upgrades it.
    restore: restore && ((record, content) => restore(record, content as C) as Content),
    beforeVersion: hooks.beforeVersion,
    strictCapture: !!hooks.strictCapture,
    comments: hooks.comments !== false,
    flushBeforeReadOnly: !!hooks.flushBeforeReadOnly,
    adoptsOpenedContent: !!hooks.adoptsOpenedContent,
    nativeReuse: nativeReuse
      ? (content) => definition.validate(content) && nativeReuse(content)
      : ordinaryHooks.nativeReuse,
    exports: {
      documentText: !!exports?.documentText,
      csv: !!exports?.csv,
      download: download && ((content) => download(checked(content, 'downloaded content'))),
    },
    feedsAnimationCatalog: !!hooks.feedsAnimationCatalog,
    readsAnimationCatalog: !!hooks.readsAnimationCatalog,
    sharedSessions: hooks.sharedSessions !== false,
    annotationSurface: !!hooks.annotationSurface,
    commentsButton: hooks.commentsButton,
  };
  return Object.freeze(erased);
}

/** A kind paired with its Playground parts. The content type is erased here. */
export interface HostKindEntry {
  readonly kind: string;
  /** The typed shared definition this entry was made from (the same object the registry lists). */
  readonly definition: KindDefinition<unknown>;
  /** Whether this Surface renders `content` that already passed the kind's `validate`. */
  accepts(content: unknown): boolean;
  /**
   * The Surface for content that passed `accepts` (checked once per content change, not per
   * render), or nothing when the session it needs is missing.
   */
  render(host: SurfaceHost, content: unknown): ReactNode;
  readonly hooks: KindHooks;
}

/**
 * Pairs a typed definition with its Surface before the type is erased, so a Surface for another
 * kind's content is a type error.
 */
export function hostKind<C>(
  definition: KindDefinition<C>,
  parts: HostKindParts<NoInfer<C>>,
): HostKindEntry {
  const { Surface, session, accepts, surfaceKey } = parts;
  return Object.freeze({
    kind: definition.kind,
    definition,
    hooks: eraseHooks(definition, parts.hooks),
    accepts: (content: unknown) =>
      definition.validate(content) && (accepts ? accepts(content) : true),
    render(host: SurfaceHost, content: unknown) {
      if (session === 'local' && (host.sharedSession || !host.session)) return null;
      if (session === 'any' && !(host.sharedSession || host.session)) return null;
      return (
        <Surface
          key={surfaceKey ? surfaceKey(host) : host.active.id}
          host={host}
          content={content as C}
        />
      );
    },
  });
}

/** One Surface per registered kind, made from the same definition object (see pairKinds). */
export function pairSurfaces(
  definitions: readonly KindDefinition<unknown>[],
  entries: readonly HostKindEntry[],
): ReadonlyMap<string, HostKindEntry> {
  return pairKinds(definitions, entries, 'Surface');
}
