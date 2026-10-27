/** Video-owned raw admission before the reviewed Storage factory publishes any target. */
import { contentHash } from '@editor-platform/artifact-core';
import { openPortableFile } from '../../file-backed-storage/browser-verifier/external-file';
import { createPersistenceFactoryV2 } from '../../file-backed-storage/integration/persistence-v2';
import { createMigrationPersistence } from '../../file-backed-storage/integration/persistence-migration';
import { verifyOriginal } from './verify-original-v2.mjs';
export function createAdmittedPersistenceV2(options) {
  return createAdmittedVideoPersistence(options, 'v2', createPersistenceFactoryV2(options));
}
/** Private common raw-media admission; native profiles retain their own strict reader. */
export function createAdmittedVideoPersistence(options, kind, factory, verify = verifyOriginal) {
  return async (live, file) => {
    const signal = options.signal ?? new globalThis.AbortController().signal;
    let migrated = false;
    if (file) {
      const external = await openPortableFile(file, options.digest, signal, options.externalBytes);
      try {
        migrated = kind === 'v2' && external.kind === 'migration-v1';
        if (external.kind !== kind && !migrated)
          throw Error('Video media Host requires matching portable profile');
        const checked = new Set();
        for (const version of external.project.versions)
          for (const source of version.content.sources) {
            signal.throwIfAborted();
            const identity = await contentHash(source);
            if (checked.has(identity)) continue;
            const original = external.originals.get(source.asset.sha256);
            if (!original) throw Error('Missing retained media original');
            await verify(source, original.blob(), signal);
            checked.add(identity);
          }
      } finally {
        external.release();
      }
    }
    signal.throwIfAborted();
    return (migrated ? createMigrationPersistence(options) : factory)(live, file);
  };
}
