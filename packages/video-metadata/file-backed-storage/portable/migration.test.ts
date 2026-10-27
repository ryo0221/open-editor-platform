import { expect, it } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import { scan, memory } from '../io';
import { createProfileProject } from './project';
import { createPortableProjects } from './versioned';
import { v1Profile } from './v1';
import { v2Profile } from './v2';
import { migrationFixture } from './migration-fixture';
import { createZip, type Entry } from './zip64';
import {
  retainMigrationSource,
  type MigrationProject,
  type ResolveMigrationSource,
} from './migration';
const signal = () => new AbortController().signal;
async function archive(entries: Entry[]) {
  const bytes: Uint8Array[] = [];
  await createZip(scan).writeZip(
    entries,
    {
      write: async (b) => {
        bytes.push(Uint8Array.from(b));
      },
    },
    signal(),
  );
  return memory(Uint8Array.from(Buffer.concat(bytes)));
}
async function fixture() {
  const { project, source, sourceWire } = await migrationFixture(scan);
  let releases = 0;
  const resolve: ResolveMigrationSource = async () => ({
    reader: sourceWire,
    assertReadable() {},
    release() {
      releases++;
    },
  });
  return { project, source, sourceWire, resolve, releases: () => releases };
}
it('roundtrips origin identities, verifies the separately retained archive and leaves original bytes intact', async () => {
  const f = await fixture();
  const before = await scan(f.sourceWire, signal());
  const all = createPortableProjects(scan);
  const wire = await archive(await all.migration.prepareProject(f.project, signal()));
  const opened = await all.open(wire, signal());
  expect(opened.kind).toBe('migration-v1');
  expect(opened.project.provenance).toEqual(f.project.provenance);
  const held = await retainMigrationSource(
    opened.project as MigrationProject,
    scan,
    f.resolve,
    signal(),
  );
  expect(held.source.versions).toEqual(f.source.versions);
  expect(held.source.capture.scope.artifactId).not.toBe(f.project.capture.scope.artifactId);
  expect(await scan(f.sourceWire, signal())).toEqual(before);
  held.release();
  expect(f.releases()).toBe(1);
  await expect(createProfileProject(scan, v2Profile).openProject(wire, signal())).rejects.toThrow();
  await expect(createProfileProject(scan, v1Profile).openProject(wire, signal())).rejects.toThrow();
});
it.each(['missing', 'unknown', 'same-id', 'wrong-target', 'missing-initial'] as const)(
  'rejects invalid provenance %s',
  async (fault) => {
    const { project } = await fixture();
    if (fault === 'missing') delete (project as Partial<MigrationProject>).provenance;
    if (fault === 'unknown')
      Object.assign(project.provenance, { remoteUrl: 'https://invalid.example/source' });
    if (fault === 'same-id')
      project.provenance.sourceArtifactId = project.provenance.targetArtifactId;
    if (fault === 'wrong-target') project.provenance.targetContentHash = 'f'.repeat(64);
    if (fault === 'missing-initial') project.provenance.targetVersionId = 'absent';
    await expect(
      createPortableProjects(scan).migration.prepareProject(project, signal()),
    ).rejects.toThrow();
  },
);
it.each(['archive-hash', 'version', 'content-hash', 'artifact'] as const)(
  'refuses unresolved source identity %s and releases the lease',
  async (fault) => {
    const f = await fixture();
    if (fault === 'archive-hash') f.project.provenance.sourceArchiveHash = 'f'.repeat(64);
    if (fault === 'version') f.project.provenance.sourceVersionId = 'missing';
    if (fault === 'content-hash') f.project.provenance.sourceContentHash = 'f'.repeat(64);
    if (fault === 'artifact') f.project.provenance.sourceArtifactId = 'other';
    await expect(retainMigrationSource(f.project, scan, f.resolve, signal())).rejects.toThrow();
    expect(f.releases()).toBe(1);
  },
);
it('rejects plausible hashes for content that is not the converter output', async () => {
  const f = await fixture();
  f.project.versions = structuredClone(f.project.versions);
  f.project.versions[0].content.sequence.id = 'changed-before-migration';
  const hash = await contentHash(f.project.versions[0].content);
  f.project.versions[0].contentHash = f.project.provenance.targetContentHash = hash;
  f.project.capture = { ...f.project.capture, contentHash: hash };
  await expect(retainMigrationSource(f.project, scan, f.resolve, signal())).rejects.toThrow(
    'converter output',
  );
  expect(f.releases()).toBe(1);
});
it('refuses missing origin and permission loss during verification', async () => {
  const f = await fixture();
  await expect(
    retainMigrationSource(
      f.project,
      scan,
      async () => {
        throw Error('Source unavailable');
      },
      signal(),
    ),
  ).rejects.toThrow('Source unavailable');
  let allowed = true;
  await expect(
    retainMigrationSource(
      f.project,
      scan,
      async () => ({
        reader: {
          size: f.sourceWire.size,
          async read(...args) {
            allowed = false;
            return f.sourceWire.read(...args);
          },
        },
        assertReadable() {
          if (!allowed) throw Error('Permission revoked');
        },
        release() {
          allowed = false;
        },
      }),
      signal(),
    ),
  ).rejects.toThrow('Permission revoked');
});
it('accepts subsequent destination edits without redefining origin and refuses incomplete archives', async () => {
  const f = await fixture();
  const next = structuredClone(f.project.versions[0]);
  next.versionId = 'edited-v2';
  next.parentVersionId = f.project.selectedVersionId;
  next.content.sequence.id = 'edited-after-migration';
  next.contentHash = await contentHash(next.content);
  f.project.versions.push(next);
  f.project.selectedVersionId = next.versionId;
  f.project.capture = { ...f.project.capture, contentHash: next.contentHash };
  const wire = await archive(
    await createPortableProjects(scan).migration.prepareProject(f.project, signal()),
  );
  const held = await retainMigrationSource(f.project, scan, f.resolve, signal());
  held.release();
  const partial = memory(await wire.read(0n, Number(wire.size) - 22, signal()));
  await expect(createPortableProjects(scan).open(partial, signal())).rejects.toThrow();
});

it.each([false, true])(
  'rejects unrelated retained roots even when selected=%s',
  async (selected) => {
    const f = await fixture();
    const unrelated = structuredClone(f.project.versions[0]);
    unrelated.versionId = 'unrelated-root';
    unrelated.content.sequence.id = 'unrelated';
    unrelated.contentHash = await contentHash(unrelated.content);
    f.project.versions.push(unrelated);
    if (selected) {
      f.project.selectedVersionId = unrelated.versionId;
      f.project.capture = { ...f.project.capture, contentHash: unrelated.contentHash };
    }
    await expect(
      createPortableProjects(scan).migration.prepareProject(f.project, signal()),
    ).rejects.toThrow('descend');
    await expect(retainMigrationSource(f.project, scan, f.resolve, signal())).rejects.toThrow(
      'descend',
    );
  },
);
