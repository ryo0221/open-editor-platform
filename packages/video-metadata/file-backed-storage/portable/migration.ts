/** Explicit v2 destination profile; source archive and media remain owned by the Host. */
import { canonicalJson } from '@editor-platform/artifact-core';
import { adoptVideoContentV2, type VideoContentV2 } from '@editor-platform/video-core';
import type { MediaImportSetV2 } from '../../host-media/m2/media-profile-v2';
import { createProfileProject, type Project, type ProjectProfile } from './project';
import { v1Profile } from './v1';
import { v2Profile } from './v2';
import { need, type Reader, type Scanner } from './io';
import type { MigrationReference } from './migration-reference';
export type MigrationProject = Project<VideoContentV2, MediaImportSetV2> & {
  provenance: MigrationReference;
};
const identity = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 256;
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const migrationProfile: ProjectProfile<VideoContentV2, MediaImportSetV2> = {
  ...v2Profile,
  format: 'video-file-zip64-migration-v1',
  validateProvenance(reference, project) {
    need(
      reference && typeof reference === 'object' && !Array.isArray(reference),
      'Migration provenance required',
    );
    need(
      Object.keys(reference).sort().join(',') ===
        [
          'converter',
          'sourceArtifactId',
          'sourceVersionId',
          'sourceContentHash',
          'sourceArchiveHash',
          'targetArtifactId',
          'targetVersionId',
          'targetContentHash',
        ]
          .sort()
          .join(','),
      'Migration provenance fields',
    );
    need(
      reference.converter === 'video-v1-to-v2-1' &&
        [
          reference.sourceArtifactId,
          reference.sourceVersionId,
          reference.targetArtifactId,
          reference.targetVersionId,
        ].every(identity) &&
        [
          reference.sourceContentHash,
          reference.sourceArchiveHash,
          reference.targetContentHash,
        ].every(hash) &&
        reference.sourceArtifactId !== reference.targetArtifactId &&
        reference.targetArtifactId === project.capture.scope.artifactId,
      'Migration identities',
    );
    const initial = project.versions.find((v) => v.versionId === reference.targetVersionId);
    need(
      initial &&
        initial.parentVersionId === null &&
        initial.contentHash === reference.targetContentHash,
      'Migration initial target version',
    );
    const versions = new Map(project.versions.map((v) => [v.versionId, v]));
    for (const version of project.versions) {
      let cursor = version;
      const seen = new Set<string>();
      while (cursor.versionId !== reference.targetVersionId) {
        need(!seen.has(cursor.versionId), 'Migration ancestry cycle');
        seen.add(cursor.versionId);
        const parent = cursor.parentVersionId && versions.get(cursor.parentVersionId);
        need(parent, 'Migration destination must descend from initial target');
        cursor = parent;
      }
    }
  },
};
/** A resolver must authorize the exact identity and retain immutable bytes through release. */
export interface RetainedMigrationSource {
  reader: Reader;
  assertReadable(): void;
  release(): void;
}
export type ResolveMigrationSource = (
  reference: Readonly<MigrationReference>,
  signal: AbortSignal,
) => Promise<RetainedMigrationSource>;
/** Full source/archive/closure and converter verification. Missing origin is never an accepted load. */
export async function retainMigrationSource(
  project: MigrationProject,
  scan: Scanner,
  resolve: ResolveMigrationSource,
  signal: AbortSignal,
) {
  const owned = structuredClone({ ...project, originals: undefined });
  // Only metadata is cloned. Reader leases remain owned by the destination Host.
  const destination = { ...owned, originals: new Map(project.originals) } as MigrationProject;
  await createProfileProject(scan, migrationProfile).validateProject(destination);
  signal.throwIfAborted();
  const reference = Object.freeze(structuredClone(destination.provenance));
  const lease = await resolve(reference, signal);
  try {
    lease.assertReadable();
    const reader: Reader = {
      size: lease.reader.size,
      async read(at, n, abort) {
        lease.assertReadable();
        const bytes = await lease.reader.read(at, n, abort);
        lease.assertReadable();
        return bytes;
      },
    };
    need(
      (await scan(reader, signal)).sha256 === reference.sourceArchiveHash,
      'Migration source archive hash',
    );
    const source = await createProfileProject(scan, v1Profile).openProject(reader, signal);
    const version = source.versions.find((v) => v.versionId === reference.sourceVersionId);
    need(
      source.capture.scope.artifactId === reference.sourceArtifactId &&
        version?.contentHash === reference.sourceContentHash,
      'Migration source version',
    );
    const initial = destination.versions.find((v) => v.versionId === reference.targetVersionId)!;
    need(
      canonicalJson(adoptVideoContentV2(version!.content)) === canonicalJson(initial.content),
      'Migration converter output',
    );
    signal.throwIfAborted();
    lease.assertReadable();
    return { source, assertReadable: () => lease.assertReadable(), release: () => lease.release() };
  } catch (error) {
    lease.release();
    throw error;
  }
}
