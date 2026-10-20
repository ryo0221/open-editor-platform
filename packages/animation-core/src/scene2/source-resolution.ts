import { requireAnimation as check, type SourceRef } from '../model';
import type { AnimationContent2, Layer2 } from './model';

// Resolve validated native ownership without parsing, cloning or mutating retained bytes.
export const sourceIdentity2 = (ref: {
  artifactId: string;
  versionId: string;
  contentHash: string;
}) => JSON.stringify([ref.artifactId, ref.versionId, ref.contentHash]);
/** One artifact/version names one immutable native hash, regardless of composition. */
export function registerAnimationSourceVersion2(identities: Map<string, string>, ref: SourceRef) {
  const key = JSON.stringify([ref.artifactId, ref.versionId]);
  check(!identities.has(key) || identities.get(key) === ref.contentHash, 'version-conflict', key);
  identities.set(key, ref.contentHash);
}
/** Embed identity joins the already validated retained closure at the consumer boundary. */
export function assertAnimationSourceVersion2(
  content: AnimationContent2,
  source: SourceRef,
  identities = new Map<string, string>(),
) {
  registerAnimationSourceVersion2(identities, source);
  const visit = (node: AnimationContent2) => {
    for (const entry of node.sources) {
      registerAnimationSourceVersion2(identities, entry.ref);
      visit(entry.content);
    }
  };
  visit(content);
}
export function resolveComposition2(
  content: AnimationContent2,
  layer: Extract<Layer2, { type: 'composition' }>,
) {
  let source = content;
  if (layer.source.type === 'exact') {
    const key = sourceIdentity2(layer.source.ref);
    let found: AnimationContent2 | undefined;
    const find = (node: AnimationContent2) => {
      for (const entry of node.sources) {
        if (sourceIdentity2(entry.ref) === key) found = entry.content;
        if (!found) find(entry.content);
      }
    };
    find(content);
    check(found, 'missing-source', layer.id);
    source = found;
  }
  const target =
    layer.source.type === 'local' ? layer.source.compositionId : layer.source.ref.compositionId;
  const composition = source.compositions.find((c) => c.id === target);
  check(composition && layer.time.sourceOut <= composition.duration, 'source-trim', layer.id);
  return { content: source, composition };
}
