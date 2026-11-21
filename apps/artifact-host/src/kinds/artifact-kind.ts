// The Artifact Host's parts for a kind, paired with its shared definition before the content type
// is erased (docs/kind-registry-design.md, 「Hostごとの描画と接続」). No React: the storage and the
// unit tests read these.
import type { Artifact } from '@editor-platform/artifact-core';
import type { KindDefinition } from '@editor-platform/artifact-kinds';
import type { EditorHostAdapter } from '@editor-platform/editor-host';
import type { HostContent } from '../content';

export interface ArtifactKindParts<C> {
  /** The name this Host lists the kind under. Absent, the list shows none. */
  label?: string;
  /** What this Host offers for the kind; `kind` and `validate` come from the definition. */
  adapter: Omit<EditorHostAdapter<HostContent>, 'kind' | 'validate'>;
  /** A further check on the definition's `validate`, for content this Host does not handle. */
  accepts?(content: C): boolean;
  /** Reads a stored or imported native file, when it needs more than `loadHostArtifact`. */
  parseNative?(text: string): Promise<Artifact<HostContent>>;
}

export interface ArtifactKindEntry {
  readonly kind: string;
  readonly definition: KindDefinition<unknown>;
  readonly label?: string;
  readonly adapter: EditorHostAdapter<HostContent>;
  readonly parseNative?: (text: string) => Promise<Artifact<HostContent>>;
}

export function artifactKind<C>(
  definition: KindDefinition<C>,
  parts: ArtifactKindParts<NoInfer<C>>,
): ArtifactKindEntry {
  const { accepts } = parts;
  return Object.freeze({
    kind: definition.kind,
    definition,
    label: parts.label,
    adapter: Object.freeze({
      ...parts.adapter,
      kind: definition.kind,
      validate: (content: unknown): content is HostContent =>
        definition.validate(content) && (accepts ? accepts(content) : true),
    }),
    parseNative: parts.parseNative,
  });
}
