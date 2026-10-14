import {
  commitVersion,
  createArtifact,
  deepFreeze,
  type ArtifactVersion,
} from '@editor-platform/artifact-core';
import type { Authority } from './authority';
import { copy } from './contracts';
export interface ConfirmedVersion<T> {
  schema: 1;
  confirmedRevision: number;
  engineVersion: number;
  version: ArtifactVersion<T>;
}
/** Captures a confirmed snapshot synchronously before hashing; later edits cannot change it. */
export async function saveConfirmedVersion<T>(
  authority: Pick<Authority<T>, 'snapshot'>,
  actorId: string,
  reason: string,
  parentVersionId: string | null = null,
): Promise<ConfirmedVersion<T>> {
  const captured = copy(authority.snapshot()),
    artifact = createArtifact(captured.domain, 'Shared artifact', captured.content);
  artifact.id = captured.artifactId;
  artifact.draft.baseVersionId = parentVersionId;
  const saved = await commitVersion(artifact, actorId, reason);
  return deepFreeze({
    schema: 1,
    confirmedRevision: captured.revision,
    engineVersion: captured.engineVersion,
    version: saved.versions[0],
  });
}
