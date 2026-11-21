// How the Playground stores, opens and imports a kind's records, beside its shared definition.
// No React: app/records.ts and app/import-artifact.ts use these, and run in unit tests.
import type { Artifact } from '@editor-platform/artifact-core';
import type { KindDefinition } from '@editor-platform/artifact-kinds';
import type { Content, StoredArtifact } from '../model';

/** Every hook is optional; absent, the Playground's ordinary record handling applies. */
export interface RecordKindHooks<C> {
  /** Why content of this kind does not open or import, instead of the generic reason. */
  invalidReason?(content: unknown): string;
  /** Stored versions are checked against their content hashes when the record opens. */
  storedVersionHashes?: boolean;
  /** Checks a stored record before it opens (the data kept beside its content). */
  verifyStored?(record: StoredArtifact): Promise<void> | void;
  /** The content a stored or imported draft opens as (an older schema read as the current one). */
  openContent?(content: C): C;
  /** Reads a native file of this kind, when it needs more than `deserializeArtifact`. */
  parseNative?(text: string): Promise<Artifact<unknown>>;
  /** An imported record keeps its id (it scopes its resources); a duplicate is refused. */
  importKeepsId?: { duplicate: string };
  /** Copies the data that travels beside content in a native file, then checks it. */
  importExtras?(record: StoredArtifact, file: StoredArtifact): Promise<void> | void;
  /** Whether imported content is checked for reusable definitions. Absent, it is. */
  reusableAdapter?(content: C): boolean;
  /** Follows other Artifacts of the same import that the draft names by id. */
  relink?(content: C, ids: ReadonlyMap<string, string>): void;
}

/** The record hooks with the content type erased; content reaches them only after `validate`. */
export interface RecordKindEntry {
  readonly kind: string;
  readonly definition: KindDefinition<unknown>;
  readonly hooks: {
    invalidReason?(content: unknown): string;
    storedVersionHashes: boolean;
    verifyStored?(record: StoredArtifact): Promise<void> | void;
    openContent(content: unknown): Content;
    parseNative?(text: string): Promise<Artifact<unknown>>;
    importKeepsId?: { duplicate: string };
    importExtras?(record: StoredArtifact, file: StoredArtifact): Promise<void> | void;
    reusableAdapter(content: unknown): boolean;
    relink?(content: unknown, ids: ReadonlyMap<string, string>): void;
  };
}

export const ordinaryRecordHooks: RecordKindEntry['hooks'] = Object.freeze({
  storedVersionHashes: false,
  openContent: (content: unknown) => content as Content,
  reusableAdapter: () => true,
});

/** Pairs a typed definition with its record hooks before the type is erased. */
export function recordKind<C>(
  definition: KindDefinition<C>,
  hooks: RecordKindHooks<NoInfer<C>> = {},
): RecordKindEntry {
  const { openContent, reusableAdapter, relink } = hooks;
  const erased: RecordKindEntry['hooks'] = {
    ...ordinaryRecordHooks,
    invalidReason: hooks.invalidReason,
    storedVersionHashes: !!hooks.storedVersionHashes,
    verifyStored: hooks.verifyStored,
    openContent: openContent
      ? (content) => openContent(content as C) as Content
      : ordinaryRecordHooks.openContent,
    parseNative: hooks.parseNative,
    importKeepsId: hooks.importKeepsId,
    importExtras: hooks.importExtras,
    reusableAdapter: reusableAdapter
      ? (content) => reusableAdapter(content as C)
      : ordinaryRecordHooks.reusableAdapter,
    relink: relink && ((content, ids) => relink(content as C, ids)),
  };
  return Object.freeze({ kind: definition.kind, definition, hooks: Object.freeze(erased) });
}
