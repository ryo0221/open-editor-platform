import {
  canonicalJson,
  contentHash,
  deepFreeze,
  type ArtifactDraft,
} from '@editor-platform/artifact-core';
import {
  immutableCommand,
  withCommandReads,
  type EditorCommand,
} from '@editor-platform/editor-core';
import {
  SCHEMA,
  SCHEMA_V1,
  TICKS_PER_SECOND_V1,
  requireAnimation as check,
  type AnimationContent,
  type AnimationContentV1,
  type PrototypeAnimationContent,
  type Rational,
} from './model';
import { validateAnimation } from './validate';
import { prepareAnimation } from './prepare';
import { frameTick } from './time';
import type { AnimationEditScope } from './commands';

/** Compatibility reader: never upgrades or normalizes stored prototype bytes. */
export function readPrototypeAnimation(input: unknown): PrototypeAnimationContent {
  const content = validateAnimation(input);
  check(content.schemaVersion === SCHEMA, 'expected-prototype', 'schemaVersion');
  return content;
}
export function readAnimationV1(input: unknown): AnimationContentV1 {
  const content = validateAnimation(input);
  check(content.schemaVersion === SCHEMA_V1, 'expected-v1', 'schemaVersion');
  return content;
}
/** Asset-free rectangle/group gate; no nested/source dependency migration is implicit. */
export async function prepareRectangleAnimationV1(input: unknown) {
  return prepareAnimation(readAnimationV1(input));
}
export function frameTickV1(frame: number, frameRate: Rational): number {
  return frameTick(frame, TICKS_PER_SECOND_V1, frameRate);
}
function convertPrototype(input: unknown): AnimationContentV1 {
  const content = readPrototypeAnimation(input);
  check(content.assets.length === 0, 'migration-assets-unsupported', 'assets');
  const convertTick = (tick: number) => {
    const scaled = BigInt(tick) * BigInt(TICKS_PER_SECOND_V1),
      divisor = BigInt(content.ticksPerSecond);
    check(scaled % divisor === 0n, 'migration-fractional-tick', String(tick));
    const converted = scaled / divisor;
    check(converted <= BigInt(Number.MAX_SAFE_INTEGER), 'migration-tick-overflow', String(tick));
    return Number(converted);
  };
  const compositions = content.compositions.map((c) => ({
    ...c,
    duration: convertTick(c.duration),
    layers: c.layers.map((layer) => {
      check(layer.type !== 'composition', 'migration-nesting-pending', layer.id);
      return { ...layer, start: convertTick(layer.start), end: convertTick(layer.end) };
    }),
    tracks: c.tracks.map((track) => ({
      ...track,
      keys: track.keys.map((key) => ({ ...key, tick: convertTick(key.tick) })),
    })),
  }));
  return readAnimationV1({
    ...content,
    schemaVersion: SCHEMA_V1,
    ticksPerSecond: TICKS_PER_SECOND_V1,
    compositions,
  });
}
/** Returns a proposal for a NEW draft only; Host owns stale revision/permission checks and persistence. */
export async function migratePrototypeDraftToV1(
  draft: ArtifactDraft<unknown>,
  expectedContentHash: string,
  updatedAt: string,
): Promise<{
  draft: ArtifactDraft<AnimationContentV1>;
  sourceContentHash: string;
  targetContentHash: string;
}> {
  const source = readPrototypeAnimation(draft.content);
  const baseVersionId = draft.baseVersionId;
  check(
    baseVersionId === null || (typeof baseVersionId === 'string' && baseVersionId.length > 0),
    'draft-base',
    'baseVersionId',
  );
  check(
    typeof updatedAt === 'string' && Number.isFinite(Date.parse(updatedAt)),
    'draft-time',
    'updatedAt',
  );
  check(
    typeof expectedContentHash === 'string' && /^[0-9a-f]{64}$/.test(expectedContentHash),
    'hash',
    'expectedContentHash',
  );
  const content = convertPrototype(source);
  const sourceContentHash = await contentHash(source);
  check(sourceContentHash === expectedContentHash, 'migration-source-mismatch', 'draft');
  const targetContentHash = await contentHash(content);
  return deepFreeze({
    draft: { content, baseVersionId, updatedAt },
    sourceContentHash,
    targetContentHash,
  });
}
/** Explicit local adoption through the existing command/history boundary, not a second migration store. */
export function migratePrototypeToV1Command(
  expected: unknown,
  scope: AnimationEditScope,
): EditorCommand<AnimationContent> {
  const before = readPrototypeAnimation(expected),
    base = canonicalJson(before),
    after = convertPrototype(before);
  return withCommandReads(
    immutableCommand('animation.migrate-v1', 'Migrate Animation draft to v1', (current) => {
      check(scope.canEdit(), 'read-only', 'migration');
      check(canonicalJson(validateAnimation(current)) === base, 'stale', 'migration');
      return readAnimationV1(after);
    }),
    { content: ['*'] },
  );
}
