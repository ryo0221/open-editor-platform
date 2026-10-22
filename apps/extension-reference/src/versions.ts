import { contentHash, deserializeArtifact, type Artifact } from '@editor-platform/artifact-core';
import { isCounter, type Counter } from '@editor-platform/extension-sample';

/** Fixture Host admission, not a generic extension reader or package verifier. */
export async function readCounterVersions(text: string): Promise<Artifact<Counter>> {
  const artifact = deserializeArtifact(text);
  const valid = (condition: unknown) => {
    if (!condition) throw new Error('Invalid saved document versions');
  };
  valid(artifact.kind === 'example.counter' && isCounter(artifact.draft.content));
  valid(typeof artifact.draft.updatedAt === 'string');
  const ids = new Map<string, string | null>();
  for (const version of artifact.versions) {
    valid(
      version.versionId.length > 0 &&
        !ids.has(version.versionId) &&
        isCounter(version.content) &&
        (version.parentVersionId === null || typeof version.parentVersionId === 'string') &&
        typeof version.createdAt === 'string' &&
        (version.createdBy === null || typeof version.createdBy === 'string') &&
        (version.reason === null || typeof version.reason === 'string'),
    );
    valid((await contentHash(version.content)) === version.contentHash);
    ids.set(version.versionId, version.parentVersionId);
  }
  valid(artifact.draft.baseVersionId === null || ids.has(artifact.draft.baseVersionId));
  for (const id of ids.keys()) {
    const seen = new Set<string>();
    let at: string | null = id;
    while (at !== null) {
      valid(!seen.has(at) && ids.has(at));
      seen.add(at);
      at = ids.get(at)!;
    }
  }
  return artifact as Artifact<Counter>;
}
