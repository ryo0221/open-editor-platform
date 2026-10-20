import { contentHash, deepFreeze, IndexedDBStorage } from '@editor-platform/artifact-core';
import type { ReferenceResolver } from '@editor-platform/artifact-references';
import { validateArtifactReferenceHistory } from '../artifact-references';
import { validateGeoRecord } from '../geo/resources';
import { createLocalSession, validContent, type Content, type StoredArtifact } from '../model';

export const storage = new IndexedDBStorage<StoredArtifact>();

// Session results are caller-owned snapshots. The Host adopts this result rather
// than defensively cloning the entire draft a second time before IndexedDB clones it.
export function editedDraft(record: StoredArtifact, content: Content): StoredArtifact {
  return { ...record, draft: { ...record.draft, content, updatedAt: new Date().toISOString() } };
}

/** Validates a stored record (freezing its versions) and opens its local draft session. */
export async function openStoredRecord(record: StoredArtifact, references: ReferenceResolver) {
  if (!validContent(record.kind, record.draft.content)) throw new Error('Invalid stored content');
  if (record.versions.some((v) => !validContent(record.kind, v.content)))
    throw new Error('Invalid stored version');
  if (record.kind === 'structured-graph' || record.kind === 'animation') {
    for (const v of record.versions)
      if ((await contentHash(v.content)) !== v.contentHash)
        throw new Error('Stored version hash mismatch');
  }
  if (record.kind === 'geo') await validateGeoRecord(record);
  record.versions.forEach(deepFreeze);
  await validateArtifactReferenceHistory(record, references);
  return createLocalSession(record.draft.content);
}
