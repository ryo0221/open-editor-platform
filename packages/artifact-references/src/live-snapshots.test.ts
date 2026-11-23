import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash } from '@editor-platform/artifact-core';
import {
  createLiveReference,
  hydrateLiveReference,
  liveSnapshotKey,
  packLiveReferences,
  unpackLiveReferences,
  validLiveReferenceItems,
  verifyRetainedLiveReference,
  type LiveReference,
  type LiveReferenceProvider,
  type LiveSource,
  type ReferenceSnapshot,
} from './index';

const source: LiveSource = {
  artifactId: 'budget',
  domain: 'finance',
  target: { kind: 'value', targetId: 'base', metricId: 'npv' },
};
const format = { style: 'decimal' as const, digits: 0, unit: '円' };
async function snapshot(versionId: string, value = 1, revision = 1): Promise<ReferenceSnapshot> {
  const content = { value, model: 'x'.repeat(2000) };
  return {
    artifactId: 'budget',
    domain: 'finance',
    versionId,
    revision,
    content,
    contentHash: await contentHash(content),
    dependencies: [],
  };
}
const provider: LiveReferenceProvider = {
  checkAccess() {},
  checkSnapshot() {},
  list: () => [
    { ...source.target, label: 'NPV' },
    { kind: 'value', targetId: 'base', metricId: 'irr', label: 'IRR' },
  ],
  resolve: (s) => ({ kind: 'value', value: (s.content as { value: number }).value }),
};
const cite = async (saved: ReferenceSnapshot, metricId = 'npv') =>
  createLiveReference(
    { ...source, target: { kind: 'value', targetId: 'base', metricId } },
    saved,
    provider,
    format,
  );
const bytes = (v: unknown) => new TextEncoder().encode(canonicalJson(v)).length;

describe('liveSnapshots: one retained copy per version (finding 79)', () => {
  it('keeps three citations of the same version as one row, and they read back whole', async () => {
    const v1 = await snapshot('v1');
    const refs = [await cite(v1), await cite(v1, 'irr'), await cite(v1)];
    expect(refs.every((r) => r.schemaVersion === 3)).toBe(true);
    const { value, liveSnapshots } = packLiveReferences({ quotes: refs });
    expect(Object.keys(liveSnapshots)).toEqual([liveSnapshotKey(v1)]);
    expect(value.quotes.every((r) => !('content' in r.snapshot))).toBe(true);
    expect(bytes(value) + bytes(liveSnapshots)).toBeLessThan(bytes(refs) / 2);
    expect(unpackLiveReferences(value, liveSnapshots).quotes).toEqual(refs);
    expect(validLiveReferenceItems(value.quotes, [], liveSnapshots)).toBe(true);
    for (const r of value.quotes) await verifyRetainedLiveReference(r, 'deck', liveSnapshots);
  });

  it('keeps another version in its own row even when its content hash is the same', async () => {
    const v1 = await snapshot('v1');
    const v2 = { ...(await snapshot('v2')), revision: 2 };
    expect(v2.contentHash).toBe(v1.contentHash);
    const { liveSnapshots } = packLiveReferences([await cite(v1), await cite(v2)]);
    expect(Object.keys(liveSnapshots).sort()).toEqual(
      [liveSnapshotKey(v1), liveSnapshotKey(v2)].sort(),
    );
  });

  it('refuses a different content, revision or hash under the same version key', async () => {
    const v1 = await snapshot('v1');
    const good = await cite(v1);
    const other = await snapshot('v1', 2);
    const conflicting: LiveReference = { ...good, snapshot: other };
    expect(() => packLiveReferences([good, conflicting])).toThrow('同じ版の内容が矛盾しています。');
    const { value, liveSnapshots } = packLiveReferences([good]);
    const later = { ...value[0], snapshot: { ...value[0].snapshot, revision: 9 } };
    expect(validLiveReferenceItems([later], [], liveSnapshots)).toBe(false);
    expect(() => hydrateLiveReference(later, liveSnapshots)).toThrow('引用の保存版がありません。');
    // A row whose content no longer matches its hash is caught by the retained check.
    const key = liveSnapshotKey(v1);
    const tampered = { [key]: { ...liveSnapshots[key], content: { value: 3 } } };
    await expect(verifyRetainedLiveReference(value[0], 'deck', tampered)).rejects.toThrow();
    // A row under another version's key is not a valid table.
    expect(
      validLiveReferenceItems(value, [], { [liveSnapshotKey(await snapshot('v9'))]: v1 }),
    ).toBe(false);
  });

  it('drops rows no citation names, and refuses a stored table with an unnamed row', async () => {
    const v1 = await snapshot('v1');
    const v2 = await snapshot('v2', 2, 2);
    const first = packLiveReferences([await cite(v1), await cite(v2)]);
    const kept = packLiveReferences([first.value[1]], first.liveSnapshots);
    expect(Object.keys(kept.liveSnapshots)).toEqual([liveSnapshotKey(v2)]);
    expect(validLiveReferenceItems(kept.value, [], first.liveSnapshots)).toBe(false);
    expect(validLiveReferenceItems([], [], first.liveSnapshots)).toBe(false);
    expect(validLiveReferenceItems(kept.value, [], kept.liveSnapshots)).toBe(true);
  });

  it('leaves schema 2 citations of other versions exactly as stored, and moves those of a packed version', async () => {
    const v1 = await snapshot('v1');
    const v2 = await snapshot('v2', 2, 2);
    const legacy = (r: LiveReference): LiveReference => ({ ...r, schemaVersion: 2 });
    const old1 = legacy(await cite(v1));
    const old2 = legacy(await cite(v2));
    const untouched = packLiveReferences([old1, old2]);
    expect(untouched.value).toEqual([old1, old2]);
    expect(untouched.liveSnapshots).toEqual({});
    // A new citation of v1 moves the v1 schema 2 copy into the table; v2 stays inline.
    const mixed = packLiveReferences([old1, old2, await cite(v1)]);
    expect(mixed.value[0].schemaVersion).toBe(3);
    expect('content' in mixed.value[0].snapshot).toBe(false);
    expect(mixed.value[1]).toEqual(old2);
    expect(Object.keys(mixed.liveSnapshots)).toEqual([liveSnapshotKey(v1)]);
    expect(validLiveReferenceItems(mixed.value, [], mixed.liveSnapshots)).toBe(true);
    // A version may not be both inline and packed in a stored surface.
    expect(validLiveReferenceItems([old1, mixed.value[2]], [], mixed.liveSnapshots)).toBe(false);
    // A stored schema 3 citation is always packed.
    expect(validLiveReferenceItems([await cite(v1)], [], {})).toBe(false);
  });

  it('counts a shared row once toward the retained bytes', async () => {
    const big = await snapshot('v1');
    const refs = Array.from({ length: 40 }, () => big).map(() => cite(big));
    const quotes = await Promise.all(refs);
    expect(bytes(quotes)).toBeGreaterThan(80_000);
    const { value, liveSnapshots } = packLiveReferences(quotes);
    expect(bytes(value) + bytes(liveSnapshots)).toBeLessThan(40_000);
    expect(validLiveReferenceItems(value, [], liveSnapshots)).toBe(true);
  });
});
