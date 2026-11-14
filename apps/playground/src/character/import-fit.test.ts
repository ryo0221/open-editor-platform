import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { blockyFigure } from '@editor-platform/character-core';
import { makeArtifact, type StoredArtifact } from '../model';
import { assertCharacterHistoryFits, assertCharacterImportFits } from './import-fit';
import { cadNativeLimit } from '../cad/resources';

// These records are sized for the 16 MB limit the Playground had before CR7f.
const nativeLimit = cadNativeLimit.bytes;
beforeAll(() => {
  cadNativeLimit.bytes = 16_000_000;
});
afterAll(() => {
  cadNativeLimit.bytes = nativeLimit;
});

describe('character import size', () => {
  it('accepts an import that keeps the native file readable and refuses one that would not', () => {
    const record = makeArtifact('character', 1) as StoredArtifact;
    const f = blockyFigure();
    expect(() => assertCharacterImportFits(record, f.doc, f.assets)).not.toThrow();
    // The same document naming a 13 MB asset: base64 in the record passes 16 MB.
    const doc = structuredClone(f.doc);
    const big = new Uint8Array(13_000_000);
    doc.assets[0] = {
      ...doc.assets[0]!,
      sha256: `sha256:${'f'.repeat(64)}`,
      byteLength: big.length,
    };
    expect(() =>
      assertCharacterImportFits(record, doc, new Map([[doc.assets[0]!.id, big]])),
    ).toThrow(/native file would be .* over the 16 MB limit/);
  });
  it('refuses an import when the assets kept for Undo would make the record unstorable', () => {
    const record = makeArtifact('character', 1) as StoredArtifact;
    const f = blockyFigure();
    // 13 MB of an earlier import's mesh, no longer named by the draft or any version.
    const kept = {
      ...record,
      cadResources: [
        ...record.cadResources!,
        {
          ...record.cadResources![0]!,
          sha256: `sha256:${'e'.repeat(64)}`,
          bytes: 'A'.repeat(13_000_000),
        },
      ],
    };
    const doc = structuredClone(f.doc);
    const mesh = new Uint8Array(3_000_000);
    doc.assets[0] = {
      ...doc.assets[0]!,
      sha256: `sha256:${'f'.repeat(64)}`,
      byteLength: mesh.length,
    };
    expect(() =>
      assertCharacterImportFits(kept, doc, new Map([[doc.assets[0]!.id, mesh]])),
    ).toThrow(/stored record would be .* assets Undo keeps/);
  });
});

describe('character history size', () => {
  it('refuses restoring content that the versions saved since would push past the limit', () => {
    const record = makeArtifact('character', 1) as StoredArtifact;
    const f = blockyFigure();
    expect(() => assertCharacterHistoryFits(record, f.doc)).not.toThrow();
    // A large earlier draft (Undo target) plus versions saved later: 4 × 5 MB of names.
    const big = structuredClone(f.doc);
    big.name = 'x'.repeat(5_000_000);
    const versions = Array.from({ length: 3 }, (_, i) => ({
      ...record.draft,
      id: `v${i}`,
      content: big,
    })) as unknown as StoredArtifact['versions'];
    expect(() => assertCharacterHistoryFits({ ...record, versions }, big)).toThrow(
      /over the 16 MB limit/,
    );
  });
});
