import { createPersistenceFactoryV3 } from '../file-backed-storage/integration/persistence-v3';
import { createAdmittedVideoPersistence } from '../host-media/m2/storage-admission-v2.mjs';
import { verifyVisualOriginalV3 } from '../host-visual/verify-original-v3.mjs';
export const createAdmittedPersistenceV3 = (options) =>
  createAdmittedVideoPersistence(
    options,
    'v3',
    createPersistenceFactoryV3(options),
    verifyVisualOriginalV3,
  );
