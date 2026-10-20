import { deepFreeze, isDeepFrozen } from '@editor-platform/artifact-core';
import { inspectAnimationEmbed, createAnimationEmbed, type AnimationEmbed } from '../embedding';
import { requireAnimation as check, type SourceRef, type AnimationContentV1 } from '../model';
import { ownJson } from '../validate';
import { EVALUATOR2, type AnimationContent2 } from './model';
import {
  prepareAnimation2,
  validateAnimationInputs2,
  preparedAnimationContent2,
  type AnimationInputValues2,
  type PreparedAnimation2,
} from './evaluate';
import { readAnimation2, sourceRef2 } from './validate';
import { upgradeAnimation2 } from './commands';
import { readAnimationV1 as inspectAnimationHostV1 } from '../v1';
import {
  assertAnimationSourceVersion2,
  registerAnimationSourceVersion2,
} from './source-resolution';
import { embedJsonSize, checkEmbedJsonSize } from './embed-budget';
import { animationLocalCompositionClosure2 } from './source-retention';
export type AnimationHostContent = AnimationContentV1 | AnimationContent2;
export interface AnimationEmbed2 {
  format: 'animation-embed-2';
  source: SourceRef;
  snapshot: AnimationContent2;
  evaluatorVersion: typeof EVALUATOR2;
  playerVersion: 'animation-player-2';
  label: string;
  posterTick: number;
  fit: 'contain';
  trigger: 'manual' | 'on-enter';
  loop: boolean;
  inputs: AnimationInputValues2;
}
export type PlayableAnimationEmbed = AnimationEmbed | AnimationEmbed2;
/** Public controls belong to the selected owner and its local composition closure.
 * Exact nested sources own separate declarations and use their published defaults. */
export function animationCompositionInputs2(content: AnimationContent2, compositionId: string) {
  const ids = new Set(animationLocalCompositionClosure2(content, compositionId).map((c) => c.id));
  return content.publicInputs.filter((input) => ids.has(input.target.compositionId));
}
const cache = new WeakMap<object, ReturnType<typeof inspect2>>();
const legacyPlayback = new WeakMap<AnimationContentV1, AnimationContent2>();
const snapshotSizes = new WeakMap<PreparedAnimation2, ReturnType<typeof embedJsonSize>>();
function snapshotSize(prepared: PreparedAnimation2) {
  let size = snapshotSizes.get(prepared);
  if (!size) {
    size = embedJsonSize(preparedAnimationContent2(prepared));
    snapshotSizes.set(prepared, size);
  }
  return size;
}
function inspect2(input: unknown) {
  const raw = ownJson(input) as AnimationEmbed2;
  return finishEmbed(raw);
}
function finishEmbed(raw: AnimationEmbed2, prepared?: PreparedAnimation2) {
  check(
    raw &&
      typeof raw === 'object' &&
      Object.keys(raw).sort().join(',') ===
        'evaluatorVersion,fit,format,inputs,label,loop,playerVersion,posterTick,snapshot,source,trigger',
    'animation-embed-fields',
    'object',
  );
  check(
    raw.format === 'animation-embed-2' &&
      raw.evaluatorVersion === EVALUATOR2 &&
      raw.playerVersion === 'animation-player-2',
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
    typeof raw.label === 'string' && raw.label.trim() && raw.label.length <= 200,
    'animation-label',
    'object',
  );
  sourceRef2(raw.source);
  prepared ??= prepareAnimation2(raw.snapshot);
  const snapshot = preparedAnimationContent2(prepared),
    composition = snapshot.compositions.find((c) => c.id === raw.source.compositionId);
  check(
    prepared.contentHash === raw.source.contentHash,
    'animation-source-hash-mismatch',
    'source',
  );
  assertAnimationSourceVersion2(snapshot, raw.source);
  check(
    composition &&
      Number.isSafeInteger(raw.posterTick) &&
      raw.posterTick >= 0 &&
      raw.posterTick <= composition.duration,
    'animation-poster-tick',
    'object',
  );
  validateAnimationInputs2(snapshot, raw.inputs);
  const { bytes } = snapshotSize(prepared);
  check(bytes <= 8 * 1024 * 1024, 'animation-snapshot-limit', 'source');
  const embed = deepFreeze({ ...raw, snapshot });
  return Object.freeze({ kind: 'scene2' as const, embed, prepared, bytes });
}
/** Per-composition wrappers share one already admitted immutable native source.
 * The token cannot be forged, and wrapper + snapshot still obey complete JSON budgets. */
export function createPreparedAnimationEmbed2(
  source: SourceRef,
  prepared: PreparedAnimation2,
  label: string,
): AnimationEmbed2 {
  const raw = ownJson({
    format: 'animation-embed-2',
    source,
    snapshot: null,
    evaluatorVersion: EVALUATOR2,
    playerVersion: 'animation-player-2',
    label,
    posterTick: 0,
    fit: 'contain',
    trigger: 'on-enter',
    loop: false,
    inputs: [],
  }) as AnimationEmbed2;
  // Resolve the token before trusting its cached native shape.
  preparedAnimationContent2(prepared);
  checkEmbedJsonSize(embedJsonSize(raw), snapshotSize(prepared));
  const result = finishEmbed(raw, prepared);
  cache.set(result.embed, result);
  return result.embed;
}
function inspectPlayable(input: unknown) {
  if (
    input &&
    typeof input === 'object' &&
    (input as { format?: unknown }).format === 'animation-embed-2'
  ) {
    if (isDeepFrozen(input)) {
      const old = cache.get(input);
      if (old) return old;
      const result = inspect2(input);
      cache.set(input, result);
      return result;
    }
    return inspect2(input);
  }
  return { kind: 'rectangle' as const, ...inspectAnimationEmbed(input) };
}
/** An optional aggregate registry also checks identities across independently valid embeds. */
export function inspectPlayableAnimationEmbed(input: unknown, identities?: Map<string, string>) {
  const inspected = inspectPlayable(input);
  if (identities) {
    if (inspected.kind === 'scene2')
      assertAnimationSourceVersion2(inspected.embed.snapshot, inspected.embed.source, identities);
    else registerAnimationSourceVersion2(identities, inspected.embed.source);
  }
  return inspected;
}
/** Prepare new consumer writes without rewriting historical pins during inspection. */
export function retainPlayableAnimationInputs(
  input: PlayableAnimationEmbed,
): PlayableAnimationEmbed {
  const inspected = inspectPlayableAnimationEmbed(input);
  if (inspected.kind !== 'scene2') return inspected.embed;
  const embed = inspected.embed,
    ids = new Set(
      animationCompositionInputs2(embed.snapshot, embed.source.compositionId).map((i) => i.id),
    ),
    inputs = embed.inputs.filter((value) => ids.has(value.inputId));
  return inputs.length === embed.inputs.length ? embed : inspect2({ ...embed, inputs }).embed;
}
export function createPlayableAnimationEmbed(
  source: SourceRef,
  content: unknown,
  label: string,
): PlayableAnimationEmbed {
  if (
    content &&
    typeof content === 'object' &&
    (content as { schemaVersion?: unknown }).schemaVersion === 2
  )
    return inspect2({
      format: 'animation-embed-2',
      source,
      snapshot: content,
      evaluatorVersion: EVALUATOR2,
      playerVersion: 'animation-player-2',
      label,
      posterTick: 0,
      fit: 'contain',
      trigger: 'on-enter',
      loop: false,
      inputs: [],
    }).embed;
  return createAnimationEmbed(source, content, label);
}
/** Validate the original pin before projecting legacy rectangles into the single current renderer.
 * The projection is private: neither the retained snapshot nor its source hash is rewritten.
 */
export function animationPlaybackContent2(input: PlayableAnimationEmbed): AnimationContent2 {
  const inspected = inspectPlayableAnimationEmbed(input);
  if (inspected.kind === 'scene2') return inspected.embed.snapshot;
  const snapshot = inspected.embed.snapshot;
  let projection = legacyPlayback.get(snapshot);
  if (!projection) {
    projection = deepFreeze(upgradeAnimation2(snapshot));
    legacyPlayback.set(snapshot, projection);
  }
  return projection;
}
/** Adopt a new exact source while retaining consumer-owned values; incompatible declarations refuse. */
export function adoptPlayableAnimationEmbed(
  previous: PlayableAnimationEmbed,
  source: SourceRef,
  content: unknown,
) {
  const current = inspectPlayableAnimationEmbed(previous).embed;
  const candidate = createPlayableAnimationEmbed(source, content, current.label);
  const duration = candidate.snapshot.compositions.find(
    (c) => c.id === source.compositionId,
  )!.duration;
  const reachable =
    current.format === 'animation-embed-2'
      ? new Set(
          animationCompositionInputs2(current.snapshot, current.source.compositionId).map(
            (i) => i.id,
          ),
        )
      : new Set<string>();
  let inputs =
    current.format === 'animation-embed-2'
      ? current.inputs.filter((i) => reachable.has(i.inputId))
      : [];
  check(
    candidate.format === 'animation-embed-2' || !inputs.length,
    'input-adoption-conflict',
    'inputs',
  );
  if (current.format === 'animation-embed-2' && candidate.format === 'animation-embed-2') {
    const candidateIds = new Set(
      animationCompositionInputs2(candidate.snapshot, source.compositionId).map((i) => i.id),
    );
    inputs = inputs.filter(
      (value) =>
        candidateIds.has(value.inputId) ||
        !candidate.snapshot.publicInputs.some((input) => input.id === value.inputId),
    );
    for (const { inputId } of inputs) {
      const before = current.snapshot.publicInputs.find((input) => input.id === inputId),
        after = candidate.snapshot.publicInputs.find((input) => input.id === inputId);
      // Missing declarations remain the input validator's unknown-input error.
      check(!after || before?.kind === after.kind, 'input-adoption-conflict', inputId);
    }
  }
  return retainPlayableAnimationInputs(
    inspectPlayableAnimationEmbed({
      ...candidate,
      posterTick: Math.min(current.posterTick, duration),
      trigger: current.trigger,
      loop: current.loop,
      ...(candidate.format === 'animation-embed-2' ? { inputs } : {}),
    }).embed,
  );
}
export function readAnimationHostContent(input: unknown): AnimationHostContent {
  if (
    input &&
    typeof input === 'object' &&
    (input as { schemaVersion?: unknown }).schemaVersion === 2
  )
    return readAnimation2(input);
  return inspectAnimationHostV1(input);
}
