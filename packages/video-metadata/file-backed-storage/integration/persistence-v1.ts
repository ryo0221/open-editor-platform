/** Storage-owned adapter for #194's exact private PersistenceFactoryV1 port. */
import type { VideoContentV1 } from '@editor-platform/video-core';
import type { PersistenceFactoryV1 } from '../../host-media/file-source/host-v1';
import { v1Profile } from '../portable/v1';
import { createProfilePersistenceFactory, type PersistenceOptions } from './persistence';
export type PersistenceOptionsV1 = PersistenceOptions<VideoContentV1>;
export function createPersistenceFactoryV1(options: PersistenceOptionsV1): PersistenceFactoryV1 {
  return createProfilePersistenceFactory({ kind: 'v1', profile: v1Profile }, options);
}
