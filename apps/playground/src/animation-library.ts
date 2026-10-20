import { isDeepFrozen, type Artifact } from '@editor-platform/artifact-core';
import {
  readAnimationHostContent,
  createPreparedAnimationEmbed2,
  prepareAnimation2,
  preparedAnimationContent2,
  type PreparedAnimation2,
} from '@editor-platform/animation-core/v2';
const preparedVersions = new WeakMap<object, PreparedAnimation2>();
function prepareVersion(content: unknown) {
  const reusable = isDeepFrozen(content) && content !== null && typeof content === 'object';
  let prepared = reusable ? preparedVersions.get(content) : undefined;
  if (!prepared) {
    const native = readAnimationHostContent(content);
    if (native.schemaVersion !== 2) return;
    prepared = prepareAnimation2(native);
    if (reusable) preparedVersions.set(content, prepared);
  }
  return prepared;
}
/** Host-owned saved catalog; no latest lookup is retained inside an adopted instance. */
export function savedAnimationCatalog(records: readonly Artifact<unknown>[]) {
  const unavailable: { label: string; reason: string }[] = [];
  const sources = records
    .filter((record) => record.kind === 'animation')
    .flatMap((record) =>
      record.versions.flatMap((version) => {
        try {
          const prepared = prepareVersion(version.content);
          if (!prepared) return [];
          const content = preparedAnimationContent2(prepared);
          return content.compositions.map((composition) => {
            const embed = createPreparedAnimationEmbed2(
              {
                artifactId: record.id,
                versionId: version.versionId,
                contentHash: version.contentHash,
                compositionId: composition.id,
              },
              prepared,
              record.name + ' / ' + composition.name,
            );
            return embed;
          });
        } catch (error) {
          unavailable.push({
            label: `${record.name} / ${version.versionId}`,
            reason: String(error),
          });
          return [];
        }
      }),
    );
  return { sources, unavailable };
}
