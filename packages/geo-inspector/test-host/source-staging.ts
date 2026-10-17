/** Private volatile test-Host staging. Not Storage, persistence or a shared extension API. */
import { contentHash } from '@editor-platform/artifact-core';
import type { ImportRequest } from '@editor-platform/geo-core';
import type { StagedImportSource } from '../src/import-workbench/surface';
type Ready = { hash: string; source: ImportRequest['source'] };
export function createSourceStaging(options: {
  limit: number;
  current(): unknown;
  beforeHash?(): Promise<void> | undefined;
  hashBytes?(bytes: Uint8Array): Promise<string>;
  hashManifest?(manifest: { name: string; format: string; bytesHash: string }): Promise<string>;
}) {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1) throw new Error('StageLimit');
  type Entry = { ready?: Ready; release(): void };
  const entries = new Map<string, Entry>();
  let next = 0,
    closed = false;
  const hashBytes =
    options.hashBytes ??
    (async (bytes: Uint8Array) => {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
      return `sha256:${Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('')}`;
    });
  return {
    get size() {
      return entries.size;
    },
    ready(id: string) {
      return entries.get(id)?.ready;
    },
    async prepare(
      bytes: Uint8Array,
      name: string,
      format: 'csv' | 'geojson',
      signal: AbortSignal,
    ): Promise<StagedImportSource> {
      options.current();
      if (closed || signal.aborted) throw new Error('SourceStageReleased');
      if (entries.size >= options.limit) throw new Error('TestHostStageLimit');
      if (!Number.isSafeInteger(next + 1)) throw new Error('SourceStageIdLimit');
      const id = `source-${++next}`;
      const release = () => {
        // Never release another reservation, even after this operation has retired.
        if (entries.get(id) === entry) entries.delete(id);
        signal.removeEventListener('abort', release);
      };
      const entry: Entry = { release };
      entries.set(id, entry); // Reserve ID AND capacity before the first await.
      signal.addEventListener('abort', release, { once: true });
      const current = () => {
        options.current();
        if (closed || signal.aborted || entries.get(id) !== entry)
          throw new Error('SourceStageReleased');
      };
      try {
        const owned = bytes.slice();
        await options.beforeHash?.();
        current();
        const hash = await hashBytes(owned);
        current();
        const manifestHash = await (options.hashManifest ?? contentHash)({
          name,
          format,
          bytesHash: hash,
        });
        current();
        const pin = Object.freeze({
          artifactId: id,
          versionId: 'test-v1',
          contentHash: `sha256:${manifestHash}`,
        });
        const source = Object.freeze({
          id,
          resourceId: `resource-${id}`,
          pin,
          attribution: 'User-selected local file; volatile test Host only.',
        });
        entry.ready = Object.freeze({ hash, source });
        return { source, release };
      } catch (error) {
        release();
        throw error;
      }
    },
    dispose() {
      if (closed) return;
      closed = true;
      for (const entry of [...entries.values()]) entry.release();
    },
  };
}
