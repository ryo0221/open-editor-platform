import { contentHash } from '@editor-platform/artifact-core';
import type { CosimSource, CosimSourceEntry } from '@editor-platform/cosim';
import { isSchematicDocument, type SchematicDocument } from '@editor-platform/schematic-core';
import { validateLadder, type LadderDocument } from '@editor-platform/ladder-core';
import type { StoredArtifact } from '../model';

/**
 * SL8c: the saved versions a co-simulation can run: the Playground's schematics and ladder
 * programs. One exact version is read by its content hash; a version that is gone, changed or
 * not valid is refused by code.
 */
function savedVersions<T>(options: {
  records(): StoredArtifact[];
  kind: 'schematic' | 'ladder';
  valid(content: unknown): boolean;
}): CosimSource<T> {
  return {
    async list(): Promise<CosimSourceEntry[]> {
      return options
        .records()
        .filter((r) => r.kind === options.kind && r.versions.length)
        .map((r) => ({
          artifactId: r.id,
          name: r.name,
          versions: [...r.versions].reverse().map((v, i, all) => ({
            versionId: v.versionId,
            label: `v${all.length - i}${v.reason ? ` — ${v.reason}` : ''}`,
            contentHash: v.contentHash,
          })),
        }));
    },
    async document(ref) {
      const record = options
        .records()
        .find((r) => r.id === ref.artifactId && r.kind === options.kind);
      const version = record?.versions.find((v) => v.versionId === ref.versionId);
      // The stored hash field is not trusted: the content itself must still hash to it.
      if (
        !version ||
        version.contentHash !== ref.contentHash ||
        (await contentHash(version.content)) !== ref.contentHash
      )
        throw new Error('source-missing');
      if (!options.valid(version.content)) throw new Error('source-invalid');
      return structuredClone(version.content) as T;
    },
  };
}

export function createCosimSources(records: () => StoredArtifact[]) {
  return {
    schematics: savedVersions<SchematicDocument>({
      records,
      kind: 'schematic',
      valid: isSchematicDocument,
    }),
    ladders: savedVersions<LadderDocument>({
      records,
      kind: 'ladder',
      valid: (c) => !validateLadder(c).some((d) => d.severity === 'error'),
    }),
  };
}
