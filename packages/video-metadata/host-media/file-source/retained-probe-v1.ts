import { contentHash } from '@editor-platform/artifact-core';
import type { ImportSetV1 } from './import-v1';
interface VerifiedInterpretations {
  versions: readonly {
    content: { sources: readonly { id: string; asset: { sha256: string } }[] };
  }[];
  plans: readonly { sourceId: string; plan: ImportSetV1 }[];
}
/** Runs after shared archive/hash/closure validation; every retained source version is checked. */
export async function checkRetainedProbesV1(
  project: VerifiedInterpretations,
  originals: ReadonlyMap<string, { blob(): Blob }>,
  probe: (original: Blob) => Promise<ImportSetV1>,
): Promise<number> {
  const plans = new Map(project.plans.map((entry) => [entry.sourceId, entry.plan]));
  const probes = new Map<string, ImportSetV1>();
  for (const version of project.versions)
    for (const source of version.content.sources) {
      const stored = plans.get(source.id);
      if (!stored) throw Error('Retained interpretation missing');
      let actual = probes.get(source.asset.sha256);
      if (!actual) {
        const original = originals.get(source.asset.sha256);
        if (!original) throw Error('Retained original missing');
        actual = await probe(original.blob());
        probes.set(source.asset.sha256, actual);
      }
      if ((await contentHash(actual)) !== (await contentHash(stored)))
        throw Error('Original probe disagrees with stored interpretation');
    }
  return probes.size;
}
