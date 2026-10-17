import { expect, it } from 'vitest';
import {
  canonicalJson,
  contentHash,
  createArtifact,
  commitVersion,
  type Artifact,
} from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { animationFixture } from './fixtures';
import {
  readAnimationV1,
  readPrototypeAnimation,
  prepareRectangleAnimationV1,
  prepareAnimation,
  evaluateAnimation,
  migratePrototypeDraftToV1,
  migratePrototypeToV1Command,
  frameTickV1,
  identityTransform,
  EVALUATOR_V1,
  type AnimationContent,
  type PrototypeAnimationContent,
} from './index';
const time = '2026-10-12T06:00:00.000Z';
function prototype(timebase = 48000) {
  const c = animationFixture();
  c.ticksPerSecond = timebase;
  const root = c.compositions[0];
  root.duration = timebase;
  root.frameRate = { numerator: 24, denominator: 1 };
  root.layers[0].end = timebase;
  root.tracks[0].keys[1].tick = timebase;
  return c;
}
const draft = (content: unknown) => ({
  content,
  baseVersionId: 'version-original',
  updatedAt: '2026-10-12T00:00:00.000Z',
});
it('explicit new-draft migration preserves old version IDs, canonical bytes, hashes and source pose', async () => {
  const original = prototype();
  const saved = await commitVersion(
    createArtifact<AnimationContent>('animation', 'Test', original),
    null,
    'prototype snapshot',
  );
  const before = canonicalJson(saved),
    old = saved.versions[0],
    oldBytes = canonicalJson(old),
    oldHash = old.contentHash;
  const migrated = await migratePrototypeDraftToV1(saved.draft, oldHash, time);
  expect(canonicalJson(saved)).toBe(before);
  expect(migrated.draft.baseVersionId).toBe(old.versionId);
  expect(migrated.draft.content.schemaVersion).toBe(1);
  expect(migrated.draft.content.ticksPerSecond).toBe(240000);
  expect(migrated.targetContentHash).not.toBe(oldHash);
  expect(migrated.sourceContentHash).toBe(oldHash);
  const adopted: Artifact<AnimationContent> = { ...saved, draft: migrated.draft };
  const next = await commitVersion(adopted, null, 'explicit v1 adoption');
  expect(canonicalJson(next.versions[0])).toBe(oldBytes);
  expect(next.versions[0].contentHash).toBe(oldHash);
  expect(next.versions[1].parentVersionId).toBe(old.versionId);
  expect(next.versions[1].versionId).not.toBe(old.versionId);
  expect(await contentHash(next.versions[0].content)).toBe(oldHash);
  const previous = await prepareAnimation(readPrototypeAnimation(next.versions[0].content));
  const current = await prepareRectangleAnimationV1(next.draft.content);
  expect(current.evaluatorVersion).toBe(EVALUATOR_V1);
  expect(evaluateAnimation(current, 'root', 120000).schemaVersion).toBe(
    'animation-rectangle-scene-1',
  );
  expect(evaluateAnimation(current, 'root', 120000).rectangles).toEqual(
    evaluateAnimation(previous, 'root', 24000).rectangles,
  );
  expect(next.draft.content.compositions[0].tracks[0].keys.map((k) => k.id)).toEqual(
    original.compositions[0].tracks[0].keys.map((k) => k.id),
  );
});
it('keeps readers distinct, does not auto-upgrade or rewrite version hashes', async () => {
  const c = prototype(),
    before = canonicalJson(c),
    hash = await contentHash(c);
  expect(readPrototypeAnimation(c).schemaVersion).toBe('animation-prototype-0');
  expect(() => readAnimationV1(c)).toThrow('expected-v1');
  await expect(prepareRectangleAnimationV1(c)).rejects.toThrow('expected-v1');
  const v1 = (await migratePrototypeDraftToV1(draft(c), hash, time)).draft.content;
  expect(() => readPrototypeAnimation(v1)).toThrow('expected-prototype');
  expect(readAnimationV1(JSON.parse(JSON.stringify(v1)))).toEqual(v1);
  expect(canonicalJson(c)).toBe(before);
  expect(await contentHash(c)).toBe(hash);
  expect(() => readAnimationV1({ ...v1, schemaVersion: 2 })).toThrow('schema');
  expect(() => readAnimationV1({ ...v1, ticksPerSecond: 48000 })).toThrow('v1-timebase');
});
it.each([24, 25, 30, 50, 60])('represents %d fps without rounding', (fps) => {
  expect(frameTickV1(fps, { numerator: fps, denominator: 1 })).toBe(240000);
});
it('supports exact fractional frame grids and refuses unsupported rates', () => {
  expect(frameTickV1(1, { numerator: 24000, denominator: 1001 })).toBe(10010);
  expect(frameTickV1(1, { numerator: 30000, denominator: 1001 })).toBe(8008);
  expect(frameTickV1(1, { numerator: 60000, denominator: 1001 })).toBe(4004);
  expect(() => frameTickV1(1, { numerator: 29, denominator: 1 })).toThrow('frame-grid');
});
it('rejects fractional conversion and overflow without changing source', async () => {
  const fractional = prototype(96000);
  fractional.compositions[0].tracks[0].keys[0].tick = 1;
  const overflow = prototype(1);
  overflow.compositions[0].frameRate = { numerator: 1, denominator: 1 };
  overflow.compositions[0].duration = Number.MAX_SAFE_INTEGER;
  overflow.compositions[0].layers[0].end = Number.MAX_SAFE_INTEGER;
  overflow.compositions[0].tracks[0].keys[1].tick = Number.MAX_SAFE_INTEGER;
  for (const [c, code] of [
    [fractional, 'migration-fractional-tick'],
    [overflow, 'migration-tick-overflow'],
  ] as const) {
    const before = canonicalJson(c);
    await expect(migratePrototypeDraftToV1(draft(c), await contentHash(c), time)).rejects.toThrow(
      code,
    );
    expect(canonicalJson(c)).toBe(before);
  }
});
it('refuses prototype nested semantics in v1 until the terminal contract is approved', async () => {
  const c = prototype();
  const child = structuredClone(c.compositions[0]);
  child.id = 'child';
  child.layers = [];
  child.tracks = [];
  c.compositions.push(child);
  c.compositions[0].layers.push({
    id: 'nest',
    parentId: null,
    start: 0,
    end: 48000,
    type: 'composition',
    transform: identityTransform(),
    source: { type: 'local', compositionId: 'child' },
    time: { sourceIn: 0, sourceOut: 48000, rate: { numerator: 1, denominator: 1 }, after: 'hold' },
  });
  await expect(prepareAnimation(c)).resolves.toBeDefined();
  await expect(migratePrototypeDraftToV1(draft(c), await contentHash(c), time)).rejects.toThrow(
    'migration-nesting-pending',
  );
  expect(() => readAnimationV1({ ...c, schemaVersion: 1, ticksPerSecond: 240000 })).toThrow(
    'v1-nesting-pending',
  );
});
it('captures source before asynchronous hashing and rejects mismatched expected hash', async () => {
  const c = prototype(),
    d = draft(c),
    hash = await contentHash(c);
  const pending = migratePrototypeDraftToV1(d, hash, time);
  c.compositions[0].width = 999;
  d.baseVersionId = 'later';
  const result = await pending;
  expect(result.draft.content.compositions[0].width).toBe(640);
  expect(result.draft.baseVersionId).toBe('version-original');
  await expect(migratePrototypeDraftToV1(d, hash, time)).rejects.toThrow(
    'migration-source-mismatch',
  );
});
it('uses existing local Undo/Redo and rejects revoked/stale migration without partial changes', () => {
  const c = prototype(),
    session = new EditorSession<AnimationContent>(c);
  let allowed = true;
  const command = migratePrototypeToV1Command(c, { canEdit: () => allowed });
  allowed = false;
  expect(() => session.execute(command)).toThrow('read-only');
  expect(session.content).toEqual(c);
  allowed = true;
  session.execute(command);
  expect(session.content.schemaVersion).toBe(1);
  expect(() => session.execute(command)).toThrow('stale');
  session.undo();
  expect(session.content).toEqual(c);
  session.redo();
  expect(session.content.schemaVersion).toBe(1);
});
it('rejects assets and a prototype fps that the fixed grid cannot represent', async () => {
  const asset = prototype();
  asset.assets = [
    { id: 'image', mediaType: 'image/png', contentHash: 'a'.repeat(64), byteLength: 1 },
  ];
  await expect(
    migratePrototypeDraftToV1(draft(asset), await contentHash(asset), time),
  ).rejects.toThrow('migration-assets-unsupported');
  const rate: PrototypeAnimationContent = prototype(29);
  rate.compositions[0].frameRate = { numerator: 29, denominator: 1 };
  await expect(
    migratePrototypeDraftToV1(draft(rate), await contentHash(rate), time),
  ).rejects.toThrow('frame-grid');
});
