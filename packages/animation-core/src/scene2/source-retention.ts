import type { AnimationContent2, Asset2, Composition2 } from './model';
import { resolveComposition2, sourceIdentity2 } from './source-resolution';
import { requireAnimation as check } from '../model';

/** Local compositions share mutable ownership; exact sources retain separate ownership. */
export function animationLocalCompositionClosure2(
  content: AnimationContent2,
  compositionId: string,
) {
  const compositions = new Map<string, Composition2>();
  function visit(id: string) {
    if (compositions.has(id)) return;
    const c = content.compositions.find((c) => c.id === id);
    check(c, 'missing-composition', id);
    compositions.set(id, c);
    for (const layer of c.layers)
      if (layer.type === 'composition' && layer.source.type === 'local')
        visit(layer.source.compositionId);
  }
  visit(compositionId);
  return [...compositions.values()];
}

/** Resource ownership follows the selected composition's local/exact closure.
 * Retained records and unused declarations are inspected without rewriting them. */
export function animationCompositionAssets2(content: AnimationContent2, compositionId: string) {
  const selected = content.compositions.find((c) => c.id === compositionId);
  if (!selected) throw Error('Missing composition');
  const visited = new Set<Composition2>(),
    assets = new Set<Asset2>();
  function visit(owner: AnimationContent2, composition: Composition2) {
    if (visited.has(composition)) return;
    visited.add(composition);
    for (const layer of composition.layers) {
      const id =
        layer.type === 'image' ? layer.assetId : layer.type === 'text' ? layer.fontAssetId : null;
      if (id) {
        const asset = owner.assets.find((a) => a.id === id);
        if (!asset) throw Error('Missing animation asset');
        assets.add(asset);
      }
      if (layer.type === 'composition') {
        const child = resolveComposition2(owner, layer);
        visit(child.content, child.composition);
      }
    }
  }
  visit(content, selected);
  return [...assets];
}

/** Keep providers for every exact layer in the editable native owner. Retained
 * records remain byte-identical, including their self-contained nested closure. */
export function referencedAnimationSources2(content: AnimationContent2) {
  const kept = new Set<AnimationContent2['sources'][number]>();
  for (const layer of content.compositions.flatMap((c) => c.layers)) {
    if (layer.type !== 'composition' || layer.source.type !== 'exact') continue;
    const key = sourceIdentity2(layer.source.ref),
      provider = animationSourceProvider2(content, key);
    if (!provider) throw Error('Missing retained source provider');
    kept.add(provider);
  }
  return content.sources.filter((entry) => kept.has(entry));
}

/** Return the owning top-level provider even when the exact version is nested. */
export function animationSourceProvider2(content: AnimationContent2, key: string) {
  const contains = (entry: AnimationContent2['sources'][number]): boolean =>
    sourceIdentity2(entry.ref) === key || entry.content.sources.some(contains);
  return (
    content.sources.find((entry) => sourceIdentity2(entry.ref) === key) ??
    content.sources.find(contains)
  );
}
