/** v2 editor storage with mandatory, separately retained source provenance. */
import type { VideoContentV2 } from '@editor-platform/video-core';
import { migrationProfile, type ResolveMigrationSource } from '../portable/migration';
import { createProfilePersistenceFactory, type PersistenceOptions } from './persistence';
export function createMigrationPersistence(
  options: PersistenceOptions<VideoContentV2> & {
    resolveMigrationSource: ResolveMigrationSource;
  },
) {
  return createProfilePersistenceFactory(
    { kind: 'migration-v1', profile: migrationProfile },
    options,
  );
}
