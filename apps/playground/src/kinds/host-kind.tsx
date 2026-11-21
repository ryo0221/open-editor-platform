import type { ComponentType, ReactNode } from 'react';
import type { KindDefinition } from '@editor-platform/artifact-kinds';
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

/**
 * One Surface per registered kind, made from the same definition object the registry lists.
 * A kind without a Surface, a second Surface or a Surface made from another definition is an
 * error at start-up, like a kind registered twice.
 */
export function pairSurfaces(
  definitions: readonly KindDefinition<unknown>[],
  entries: readonly HostKindEntry[],
): ReadonlyMap<string, HostKindEntry> {
  const byKind = new Map<string, HostKindEntry>();
  for (const entry of entries) {
    if (byKind.has(entry.kind)) throw new Error(`Surface registered twice: ${entry.kind}`);
    byKind.set(entry.kind, entry);
  }
  for (const definition of definitions) {
    const entry = byKind.get(definition.kind);
    if (!entry) throw new Error(`No Surface for kind: ${definition.kind}`);
    if (entry.definition !== definition)
      throw new Error(`Surface for ${definition.kind} uses another definition`);
  }
  if (byKind.size !== definitions.length)
    throw new Error(
      `Surface without a registered kind: ${[...byKind.keys()]
        .filter((kind) => !definitions.some((definition) => definition.kind === kind))
        .join(', ')}`,
    );
  return byKind;
}
