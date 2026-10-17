/** Video-owned raw admission before the reviewed Storage factory publishes any target. */
import { contentHash } from '@editor-platform/artifact-core';
import { openPortableFile } from '../../file-backed-storage/browser-verifier/external-file';
import { createPersistenceFactoryV2 } from '../../file-backed-storage/integration/persistence-v2';
import { verifyOriginal } from './verify-original-v2.mjs';
export function createAdmittedPersistenceV2(options) {
  const factory = createPersistenceFactoryV2(options);
  return async (live, file) => {
    const signal = options.signal ?? new globalThis.AbortController().signal;
    if (file) {
      const external = await openPortableFile(file, options.digest, signal, options.externalBytes);
      try {
        if (external.kind !== 'v2') throw Error('V2 media Host requires v2 portable profile');
        const checked = new Set();
        for (const version of external.project.versions)
          for (const source of version.content.sources) {
            signal.throwIfAborted();
            const identity = await contentHash(source);
            if (checked.has(identity)) continue;
            const original = external.originals.get(source.asset.sha256);
            if (!original) throw Error('Missing retained media original');
            await verifyOriginal(source, original.blob(), signal);
            checked.add(identity);
          }
      } finally {
        external.release();
      }
    }
    signal.throwIfAborted();
    return factory(live, file);
  };
}
