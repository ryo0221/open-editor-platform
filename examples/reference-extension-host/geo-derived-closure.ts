/** Validate every derived value against retained, hash-verified native inputs. */
import { canonicalJson } from '@editor-platform/artifact-core';
import {
  createPinnedGeoJoinBetween,
  compareGeoVersions,
  type Pin,
} from '@editor-platform/geo-core';
import {
  checkedSourceEnvelope,
  sourceBudgets,
  sourceLimits,
  type GeoSourceEnvelope,
} from './geo-source-envelope';
export async function verifyDerivedClosure(
  root: GeoSourceEnvelope,
  versions: { id: string; text: string }[],
  current: () => void,
) {
  const cache = new Map<string, GeoSourceEnvelope>(),
    path = new Set<string>();
  const resolve = async (pin: Pin) => {
    if (pin.artifactId !== root.nativeVersion.artifactId) throw Error('GeoDerivedArtifactMissing');
    let record = cache.get(pin.versionId);
    if (!record) {
      const entry = versions.find((v) => v.id === pin.versionId);
      if (!entry) throw Error('GeoDerivedVersionMissing');
      record = await checkedSourceEnvelope(entry.text, pin.artifactId);
      current();
      if (record.nativeVersion.versionId !== entry.id) throw Error('GeoDerivedIdentity');
      cache.set(pin.versionId, record);
    }
    if ('sha256:' + record.nativeVersion.contentHash !== pin.contentHash)
      throw Error('GeoDerivedHash');
    await verify(record);
    return { content: record.request.content, pin };
  };
  const verified = new Set<string>();
  async function verify(record: GeoSourceEnvelope): Promise<void> {
    const id = record.nativeVersion.versionId;
    if (verified.has(id)) return;
    if (path.has(id) || path.size >= sourceLimits.versions) throw Error('GeoDerivedCycle');
    path.add(id);
    for (const j of record.request.content.workspace?.joins ?? []) {
      const left = await resolve(j.inputs.left),
        right = await resolve(j.inputs.right);
      if (
        canonicalJson(createPinnedGeoJoinBetween(left, right, j, sourceBudgets)) !==
        canonicalJson(j)
      )
        throw Error('GeoDerivedJoinMismatch');
    }
    for (const c of record.request.content.workspace?.comparisons ?? []) {
      const before = await resolve(c.before),
        after = await resolve(c.after);
      if (canonicalJson(compareGeoVersions(before, after, c, sourceBudgets)) !== canonicalJson(c))
        throw Error('GeoDerivedComparisonMismatch');
    }
    path.delete(id);
    verified.add(id);
    current();
  }
  await verify(root);
}
