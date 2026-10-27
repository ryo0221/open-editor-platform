/** Generated metadata fixture; never claims valid codec media. */
import { commitVersion, createArtifact } from '@editor-platform/artifact-core';
import { adoptVideoContentV2 } from '@editor-platform/video-core';
import { v1Fixture } from './v1-fixture';
import { createProfileProject } from './project';
import { v1Profile } from './v1';
import { createZip, type Entry } from './zip64';
import { memory, type Scanner } from './io';
import type { MigrationProject } from './migration';
export async function fixtureArchive(scan: Scanner, entries: Entry[]) {
  const chunks: Uint8Array[] = [];
  const signal = new AbortController().signal;
  await createZip(scan).writeZip(
    entries,
    {
      write: async (b) => {
        chunks.push(Uint8Array.from(b));
      },
    },
    signal,
  );
  const bytes = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}
export async function migrationFixture(scan: Scanner) {
  const signal = new AbortController().signal;
  const source = await v1Fixture(scan);
  const sourceBytes = await fixtureArchive(
    scan,
    await createProfileProject(scan, v1Profile).prepareProject(source, signal),
  );
  const sourceWire = memory(sourceBytes);
  const selected = source.versions.find((v) => v.versionId === source.selectedVersionId)!;
  const target = await commitVersion(
    createArtifact('video', 'Migrated', adoptVideoContentV2(selected.content)),
    null,
    'Explicit migration',
  );
  const version = target.versions[0];
  const project: MigrationProject = {
    operationId: 'migration-save',
    selectedVersionId: version.versionId,
    capture: {
      scope: { artifactId: target.id, sessionId: 'migration', generation: '1' },
      revision: { kind: 'local-draft', sessionId: 'migration', sequence: 0 },
      contentHash: version.contentHash,
    },
    versions: [version],
    plans: source.plans.map((x) => ({
      sourceId: x.sourceId,
      plan: { ...x.plan, format: 'video-media-interpretation-v2', profile: 'av-sdr-v2' },
    })),
    originals: source.originals,
    provenance: {
      converter: 'video-v1-to-v2-1',
      sourceArtifactId: selected.artifactId,
      sourceVersionId: selected.versionId,
      sourceContentHash: selected.contentHash,
      sourceArchiveHash: (await scan(sourceWire, signal)).sha256,
      targetArtifactId: target.id,
      targetVersionId: version.versionId,
      targetContentHash: version.contentHash,
    },
  };
  return { project, source, sourceWire, sourceBytes };
}
