/** Storage-owned adapter for #210's exact private PersistenceFactoryV2 port. */
import type { VideoContentV2 } from '@editor-platform/video-core';
import type { PersistenceFactoryV2 } from '../../host-media/m2/host-v2';
import { v2Profile } from '../portable/v2';
import { createProfilePersistenceFactory, type PersistenceOptions } from './persistence';
export type PersistenceOptionsV2 = PersistenceOptions<VideoContentV2>;
export function createPersistenceFactoryV2(options: PersistenceOptionsV2): PersistenceFactoryV2 {
  return createProfilePersistenceFactory({ kind: 'v2', profile: v2Profile }, options);
}
