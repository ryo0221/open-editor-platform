import { describe, expect, it } from 'vitest';
import type { CharacterAssetRef, CharacterDocument } from '@editor-platform/character-core';
import { makeArtifact, type StoredArtifact } from '../model';
import { encodeBytes } from '../cad/resources';
import { characterMeshRecord } from './mesh-assets';

const asset = (n: number, size: number) => {
  const ref: CharacterAssetRef = {
    id: `mesh-${n}`,
    kind: 'mesh-epm',
    sha256: `sha256:${n.toString(16).padStart(64, '0')}`,
    byteLength: size,
    mediaType: 'model/x-editor-platform-mesh',
  };
  return { ref, bytes: new Uint8Array(size) };
};
const resource = (a: ReturnType<typeof asset>) => ({
  kind: a.ref.kind as never,
  sha256: a.ref.sha256,
  byteLength: a.ref.byteLength,
  mediaType: a.ref.mediaType,
  encoding: 'base64' as const,
  bytes: encodeBytes(a.bytes),
});
const naming = (doc: CharacterDocument, ...a: ReturnType<typeof asset>[]) => ({
  ...doc,
  assets: [...doc.assets, ...a.map((x) => x.ref)],
});
const hashes = (r: StoredArtifact) => (r.cadResources ?? []).map((x) => x.sha256);

describe('character mesh edit record (C3f)', () => {
  const base = makeArtifact('character', 1) as StoredArtifact;
  const content = base.draft.content as unknown as CharacterDocument;

  it('keeps the new asset and what the history reaches, and drops the rest', () => {
    const [undone, gone, redone, next] = [1, 2, 3, 4].map((n) => asset(n, 1000));
    const record = {
      ...base,
      cadResources: [...(base.cadResources ?? []), ...[undone, gone, redone].map(resource)],
    };
    const out = characterMeshRecord({
      record,
      content,
      undo: [naming(content, undone)],
      redo: [naming(content, redone)],
      ...next,
    });
    expect(out.forget).toBe(0);
    expect(hashes(out.record)).toEqual([
      ...hashes(base),
      undone.ref.sha256,
      redone.ref.sha256,
      next.ref.sha256,
    ]);
    // The draft is not changed: the edit names the asset afterwards.
    expect(out.record.draft).toBe(record.draft);
  });

  it('gives up the oldest Undo entries when the stored record would pass 16 MB', () => {
    const [a, b, c] = [1, 2, 3].map((n) => asset(n, 4_000_000));
    const record = {
      ...base,
      cadResources: [...(base.cadResources ?? []), resource(a), resource(b)],
    };
    // Undo oldest first: a, then b. a + b + c in base64 is about 16 MB.
    const out = characterMeshRecord({
      record,
      content,
      undo: [naming(content, a), naming(content, b)],
      redo: [],
      ...c,
    });
    expect(out.forget).toBe(1);
    expect(hashes(out.record)).not.toContain(a.ref.sha256);
    expect(hashes(out.record)).toContain(b.ref.sha256);
  });

  it('refuses when the native file itself would pass 16 MB', () => {
    const big = asset(9, 13_000_000);
    expect(() =>
      characterMeshRecord({ record: base, content, undo: [], redo: [], ...big }),
    ).toThrow(/native file would be .* over the 16 MB limit/);
  });

  it('refuses when the content and Redo alone would not fit', () => {
    const [a, b] = [1, 2].map((n) => asset(n, 6_000_000));
    const record = { ...base, cadResources: [...(base.cadResources ?? []), resource(a)] };
    expect(() =>
      characterMeshRecord({ record, content, undo: [], redo: [naming(content, a)], ...b }),
    ).toThrow(/even without Undo history/);
  });
});
