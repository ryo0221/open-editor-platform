import { canonicalJson, deepFreeze, isDeepFrozen } from '@editor-platform/artifact-core';
import {
  EVALUATOR_V1,
  identityTransform,
  requireAnimation as check,
  type AnimationContentV1,
  type SourceRef,
} from './model';
import { readAnimationV1 } from './v1';
import { prepareRectangleAnimationV1Sync, type PreparedAnimation } from './prepare';

export const ANIMATION_EMBED_VERSION = 'animation-embed-rectangle-1' as const;
export const ANIMATION_PLAYER_V1 = 'animation-rectangle-player-1' as const;
export const ANIMATION_EMBED_BYTES = 2 * 1024 * 1024;
export interface AnimationEmbed {
  format: typeof ANIMATION_EMBED_VERSION;
  source: SourceRef;
  snapshot: AnimationContentV1;
  evaluatorVersion: typeof EVALUATOR_V1;
  playerVersion: typeof ANIMATION_PLAYER_V1;
  label: string;
  posterTick: number;
  fit: 'contain';
  trigger: 'manual' | 'on-enter';
  loop: boolean;
}
const cache = new WeakMap<object, ReturnType<typeof inspectUncached>>();
function inspectUncached(value: unknown) {
  check(!!value && typeof value === 'object', 'animation-embed', 'object');
  const raw = value as AnimationEmbed;
  check(
    Object.keys(raw).sort().join(',') ===
      'evaluatorVersion,fit,format,label,loop,playerVersion,posterTick,snapshot,source,trigger',
    'animation-embed-fields',
    'object',
  );
  check(
    raw.format === ANIMATION_EMBED_VERSION &&
      raw.evaluatorVersion === EVALUATOR_V1 &&
      raw.playerVersion === ANIMATION_PLAYER_V1,
    'animation-embed-version',
    'object',
  );
  check(
    raw.fit === 'contain' &&
      ['manual', 'on-enter'].includes(raw.trigger) &&
      typeof raw.loop === 'boolean',
    'animation-playback',
    'object',
  );
  check(
    typeof raw.label === 'string' && raw.label.trim().length > 0 && raw.label.length <= 200,
    'animation-label',
    'object',
  );
  const ref = raw.source;
  check(
    !!ref &&
      typeof ref === 'object' &&
      Object.keys(ref).sort().join(',') === 'artifactId,compositionId,contentHash,versionId',
    'animation-source',
    'source',
  );
  for (const k of ['artifactId', 'versionId', 'compositionId'] as const)
    check(
      typeof ref[k] === 'string' && ref[k].length > 0 && ref[k].length <= 200,
      'animation-source',
      k,
    );
  check(
    typeof ref.contentHash === 'string' && /^[a-f0-9]{64}$/.test(ref.contentHash),
    'animation-source-hash',
    'source',
  );
  const snapshot = readAnimationV1(raw.snapshot);
  const bytes = new TextEncoder().encode(canonicalJson(snapshot)).byteLength;
  check(bytes <= ANIMATION_EMBED_BYTES, 'animation-snapshot-limit', 'source');
  const prepared = prepareRectangleAnimationV1Sync(snapshot);
  check(prepared.contentHash === ref.contentHash, 'animation-source-hash-mismatch', 'source');
  const composition = snapshot.compositions.find((c) => c.id === ref.compositionId);
  check(
    composition &&
      Number.isSafeInteger(raw.posterTick) &&
      raw.posterTick >= 0 &&
      raw.posterTick <= composition.duration,
    'animation-poster-tick',
    'object',
  );
  const embed: AnimationEmbed = deepFreeze({
    format: raw.format,
    source: { ...ref },
    snapshot,
    evaluatorVersion: raw.evaluatorVersion,
    playerVersion: raw.playerVersion,
    label: raw.label,
    posterTick: raw.posterTick,
    fit: raw.fit,
    trigger: raw.trigger,
    loop: raw.loop,
  });
  return Object.freeze({ embed, prepared, bytes });
}
/** Integrity is checked from retained native bytes; no source catalog or latest lookup. */
export function inspectAnimationEmbed(value: unknown): {
  embed: AnimationEmbed;
  prepared: PreparedAnimation;
  bytes: number;
} {
  if (value && typeof value === 'object' && isDeepFrozen(value)) {
    const old = cache.get(value);
    if (old) return old;
    const result = inspectUncached(value);
    cache.set(value, result);
    return result;
  }
  return inspectUncached(value);
}
export function createAnimationEmbed(
  source: SourceRef,
  content: unknown,
  label: string,
): AnimationEmbed {
  return inspectAnimationEmbed({
    format: ANIMATION_EMBED_VERSION,
    source,
    snapshot: content,
    evaluatorVersion: EVALUATOR_V1,
    playerVersion: ANIMATION_PLAYER_V1,
    label,
    posterTick: 0,
    fit: 'contain',
    trigger: 'on-enter',
    loop: false,
  }).embed;
}
export function createRectangleAnimation(): AnimationContentV1 {
  return {
    schemaVersion: 1,
    ticksPerSecond: 240000,
    rootCompositionId: 'root',
    assets: [],
    compositions: [
      {
        id: 'root',
        width: 640,
        height: 360,
        duration: 960000,
        frameRate: { numerator: 30, denominator: 1 },
        layers: [
          {
            id: 'group',
            type: 'group',
            parentId: null,
            start: 0,
            end: 960000,
            transform: identityTransform(),
          },
        ],
        tracks: [],
      },
    ],
  };
}
