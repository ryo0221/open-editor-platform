/** New explicit v0/v1/v2 reader; legacy v0/v1 entrypoints and writer bytes remain untouched. */
import { createVersionedProject } from './v1';
import { createProfileProject } from './project';
import { v2Profile } from './v2';
import { v3Profile } from './v3';
import { migrationProfile, type MigrationProject } from './migration';
import { createZip } from './zip64';
import { need, read, type Reader, type Scanner } from './io';
export function createPortableProjects(scan: Scanner) {
  const legacy = createVersionedProject(scan);
  const v2 = createProfileProject(scan, v2Profile);
  const v3 = createProfileProject(scan, v3Profile);
  const migration = createProfileProject(scan, migrationProfile);
  return {
    migration,
    v0: legacy.v0,
    v1: legacy.v1,
    v2,
    v3,
    async open(reader: Reader, signal: AbortSignal) {
      const entries = await createZip(scan).readZip(reader, signal);
      need(entries[0]?.name === 'manifest.json' && entries[0].size <= 65536n, 'Manifest budget');
      const raw: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          await read(entries[0].reader, 0n, Number(entries[0].size), signal),
        ),
      );
      need(raw && typeof raw === 'object' && 'format' in raw, 'Manifest profile');
      if (raw.format === v3Profile.format)
        return { kind: 'v3' as const, project: await v3.openProject(reader, signal) };
      if (raw.format === migrationProfile.format)
        return {
          kind: 'migration-v1' as const,
          project: (await migration.openProject(reader, signal)) as MigrationProject,
        };
      if (raw.format === v2Profile.format)
        return { kind: 'v2' as const, project: await v2.openProject(reader, signal) };
      // Existing readers repeat full canonical/native/closure/hash validation, including refusal of unknown profiles.
      return legacy.open(reader, signal);
    },
  };
}
