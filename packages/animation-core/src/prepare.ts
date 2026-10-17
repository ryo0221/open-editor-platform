import { JsonBudget } from './json-budget';
import { contentHash, deepFreeze } from '@editor-platform/artifact-core';
import {
  EVALUATOR,
  EVALUATOR_V1,
  requireAnimation as check,
  type AnimationContent,
  type RetainedSource,
  type SuppliedAsset,
  type SourceRef,
  type Layer,
} from './model';
import { ownJson, sourceRef, validateWithBudget } from './validate';

export interface PreparedAnimation {
  readonly evaluatorVersion: typeof EVALUATOR | typeof EVALUATOR_V1;
  readonly contentHash: string;
}
interface State {
  root: AnimationContent;
  sources: Map<string, AnimationContent>;
}
const states = new WeakMap<PreparedAnimation, State>();
export const sourceKey = (ref: SourceRef) =>
  JSON.stringify([ref.artifactId, ref.versionId, ref.contentHash]);
export function preparedState(prepared: PreparedAnimation): State {
  const state = states.get(prepared);
  check(state, 'unprepared', 'source');
  return state;
}
export function resolveLayer(
  state: State,
  content: AnimationContent,
  layer: Extract<Layer, { type: 'composition' }>,
) {
  const source = layer.source;
  const child = source.type === 'local' ? content : state.sources.get(sourceKey(source.ref));
  const id = source.type === 'local' ? source.compositionId : source.ref.compositionId;
  check(child, 'missing-source', layer.id);
  const composition = child.compositions.find((c) => c.id === id);
  check(composition && layer.time.sourceOut <= composition.duration, 'source-trim', layer.id);
  return { content: child, composition };
}
export function prepareAnimation(
  input: unknown,
  retained: readonly RetainedSource[] = [],
  supplied: readonly SuppliedAsset[] = [],
): Promise<PreparedAnimation> {
  return prepareWithBudget(input, retained, supplied, new JsonBudget());
}
/** Internal test seam; production callers cannot relax the public preparation limits. */
export async function prepareWithBudget(
  input: unknown,
  retained: readonly RetainedSource[],
  supplied: readonly SuppliedAsset[],
  budget: JsonBudget,
): Promise<PreparedAnimation> {
  // Copy every caller-owned value before the first await.
  const root = validateWithBudget(input, budget);
  check(Array.isArray(retained) && retained.length <= 100, 'closure-limit', 'retained');
  const sources = new Map<string, AnimationContent>();
  const pins = new Map<string, string>();
  const refs: SourceRef[] = [];
  for (const entry of retained) {
    const ref = ownJson(entry.ref, budget);
    sourceRef(ref);
    const content = validateWithBudget(entry.content, budget);
    const key = sourceKey(ref);
    check(!sources.has(key), 'duplicate-source', key);
    const identity = JSON.stringify([ref.artifactId, ref.versionId]);
    check(
      !pins.has(identity) || pins.get(identity) === ref.contentHash,
      'version-conflict',
      identity,
    );
    pins.set(identity, ref.contentHash);
    sources.set(key, content);
    refs.push(ref);
    check(
      content.compositions.some((c) => c.id === ref.compositionId),
      'missing-composition',
      key,
    );
  }
  check(Array.isArray(supplied) && supplied.length <= 10000, 'asset-limit', 'assets');
  let byteCount = 0;
  const assets = new Map<string, Uint8Array>();
  for (const asset of supplied) {
    check(
      typeof asset.contentHash === 'string' &&
        /^[0-9a-f]{64}$/.test(asset.contentHash) &&
        asset.bytes instanceof Uint8Array,
      'asset',
      'assets',
    );
    byteCount += asset.bytes.byteLength;
    check(
      asset.bytes.byteLength <= 16 * 1024 * 1024 && byteCount <= 32 * 1024 * 1024,
      'asset-limit',
      'bytes',
    );
    check(!assets.has(asset.contentHash), 'duplicate-asset', 'bytes');
    assets.set(asset.contentHash, new Uint8Array(asset.bytes));
  }
  const state = { root, sources };
  const all = [root, ...sources.values()];
  // Count all expanded layers independent of visibility, before any evaluation.
  const walk = (
    content: AnimationContent,
    compositionId: string,
    stack: string[],
    sourceStack: AnimationContent[],
  ): number => {
    const identity = `${all.indexOf(content)}:${compositionId}`;
    check(stack.length < 16 && !stack.includes(identity), 'cycle-depth', identity);
    const c = content.compositions.find((c) => c.id === compositionId)!;
    let count = c.layers.length;
    for (const layer of c.layers)
      if (layer.type === 'composition') {
        const child = resolveLayer(state, content, layer);
        if (layer.source.type === 'exact')
          check(!sourceStack.includes(child.content), 'source-cycle', identity);
        count += walk(
          child.content,
          child.composition.id,
          [...stack, identity],
          layer.source.type === 'exact' ? [...sourceStack, child.content] : sourceStack,
        );
        check(count <= 20000, 'expansion', identity);
      }
    return count;
  };
  for (const content of all)
    for (const composition of content.compositions) walk(content, composition.id, [], [content]);
  for (const ref of refs)
    check(
      (await contentHash(sources.get(sourceKey(ref)))) === ref.contentHash,
      'hash-mismatch',
      sourceKey(ref),
    );
  for (const [hash, bytes] of assets) {
    const actual = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    check(actual === hash, 'asset-hash', hash);
  }
  for (const content of all)
    for (const asset of content.assets)
      check(
        assets.get(asset.contentHash)?.byteLength === asset.byteLength,
        'missing-asset',
        asset.id,
      );
  all.forEach(deepFreeze);
  const prepared = Object.freeze({
    evaluatorVersion: root.schemaVersion === 1 ? EVALUATOR_V1 : EVALUATOR,
    contentHash: await contentHash(root),
  });
  states.set(prepared, state);
  return prepared;
}

/** Provisional read-only metadata for the isolated Player; no Host registration. */
export function inspectPreparedComposition(prepared: PreparedAnimation, compositionId: string) {
  const state = preparedState(prepared);
  const composition = state.root.compositions.find((c) => c.id === compositionId);
  check(composition, 'missing-composition', compositionId);
  return Object.freeze({
    schemaVersion: state.root.schemaVersion,
    width: composition.width,
    height: composition.height,
    duration: composition.duration,
    ticksPerSecond: state.root.ticksPerSecond,
    hasAssets: [state.root, ...state.sources.values()].some((content) => content.assets.length > 0),
  });
}
