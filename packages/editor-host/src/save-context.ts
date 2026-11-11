import type { Artifact, StorageAdapter } from '@editor-platform/artifact-core';
import type { LocalDraftRevision } from '@editor-platform/editor-core';

/** Native facts captured for one storage write, not a durable receipt or authorization. */
export interface HostSaveContext {
  readonly schemaVersion: 1;
  readonly artifactId: string;
  readonly kind: string;
  readonly revision: Readonly<LocalDraftRevision>;
  readonly baseVersionId: string | null;
  readonly versionId: string | null;
  /** Hash of the captured draft content; draft-only writes do not create an Exact version. */
  readonly contentHash: string;
  readonly committed: boolean;
  readonly proposalTransactions: readonly string[];
}

/** The same frozen context object is reused when a captured save is retried.
 * A Host can associate its own operation ID with this object and persist both the
 * artifact and its evidence atomically. Ordinary non-controller puts have no context.
 */
export interface HostArtifactStorage<T = unknown> extends StorageAdapter<Artifact<T>> {
  put(value: Artifact<T>, context?: HostSaveContext): Promise<void>;
}
