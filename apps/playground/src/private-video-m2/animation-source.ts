/** Adapter over the existing Artifact Library; no Video-owned duplicate source catalog. */
import {
  clone,
  deepFreeze,
  type Artifact,
  type StorageAdapter,
} from '@editor-platform/artifact-core';
import type { AnimationEmbed2 } from '@editor-platform/animation-core/v2';
import type { AnimationSourcePort } from '../../../../packages/video-metadata/host-animation/host-v3';
import { savedAnimationCatalog } from '../animation-library';
type Source = AnimationEmbed2['source'];
export function createVideoAnimationSources(
  storage: Pick<StorageAdapter<Artifact<unknown>>, 'list' | 'get'>,
  canRead: (source: Readonly<Source>) => boolean,
): AnimationSourcePort {
  return {
    async list(signal) {
      signal.throwIfAborted();
      const records = await storage.list();
      signal.throwIfAborted();
      const catalog = savedAnimationCatalog(records);
      return catalog.sources
        .filter((embed) => canRead(embed.source))
        .map((embed) => ({ label: embed.label, source: clone(embed.source) }));
    },
    async retain(request, signal) {
      const source = deepFreeze(clone(request));
      let released = false;
      const check = () => {
        signal.throwIfAborted();
        if (released || !canRead(source)) throw Error('Animation source permission revoked');
      };
      check();
      const record = await storage.get(source.artifactId);
      check();
      if (!record || record.kind !== 'animation') throw Error('Exact Animation source unavailable');
      const versions = record.versions.filter((v) => v.versionId === source.versionId);
      if (
        versions.length !== 1 ||
        versions[0].artifactId !== source.artifactId ||
        versions[0].contentHash !== source.contentHash
      )
        throw Error('Exact Animation version mismatch');
      // Host owns the immutable native snapshot; admission revalidates its hash/subset.
      const snapshot = deepFreeze(clone(versions[0].content));
      return {
        snapshot,
        assertAuthorized: check,
        release() {
          released = true;
        },
      };
    },
  };
}
