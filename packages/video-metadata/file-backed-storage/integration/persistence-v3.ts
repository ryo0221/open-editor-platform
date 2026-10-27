import type { VideoContentV3 } from '@editor-platform/video-core';
import type { PersistenceFactoryV2 } from '../../host-media/m2/host-v2';
import { v3Profile } from '../portable/v3';
import { createProfilePersistenceFactory, type PersistenceOptions } from './persistence';
export function createPersistenceFactoryV3(
  options: PersistenceOptions<VideoContentV3>,
): PersistenceFactoryV2<VideoContentV3> {
  return createProfilePersistenceFactory({ kind: 'v3', profile: v3Profile }, options);
}
