import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { commitVersion, createArtifact } from '@editor-platform/artifact-core';
import { cadContentHash, r2bParts, type CadDocument } from '@editor-platform/cad-core';
import { f170SmallLine, type FactoryDocument } from '@editor-platform/factory-core';
import type { StoredArtifact } from '../model';
import {
  factoryLookChoices,
  mergeFactoryLooks,
  portableFactoryLooks,
  stageFactoryLook,
  validateFactoryLooks,
} from './looks';

const stored = async (kind: string, name: string, content: unknown, versions = 1) => {
  let a = createArtifact(kind as never, name, content as never);
  for (let i = 0; i < versions; i++) a = await commitVersion(a, null, `v${i + 1}`);
  return { ...a, annotations: [] } as unknown as StoredArtifact;
};
/** The r2b assembly saved as a CAD Artifact, with the versions it places (nested) kept. */
async function cadSource() {
  const f = r2bParts();
  const source = await stored('cad', 'Rig', f.assembly);
  source.cadParts = [...f.closure].map(([contentHash, content]) => ({ contentHash, content }));
  return { f, source };
}
const lookOn = (record: StoredArtifact, hash: string) => {
  const doc = record.draft.content as unknown as FactoryDocument;
  doc.objects[1]!.look = { artifactId: 'a', versionId: 'v', contentHash: hash };
};

// TS-2667: FT4c a CAD version kept with the factory as an object's look.
describe('FT4c factory looks (TS-2667)', () => {
  it('lists saved CAD versions, newest first, never drafts or other kinds', async () => {
    const { source } = await cadSource();
    const two = await stored('cad', 'Press', r2bParts().plate.content, 2);
    const factory = await stored('factory', 'Line', f170SmallLine());
    const choices = factoryLookChoices([source, two, factory]);
    expect(choices.map((c) => c.label)).toEqual([
      'Rig — v1 (v1)',
      'Press — v2 (v2)',
      'Press — v1 (v1)',
    ]);
    expect(choices[1]!.versionId).toBe(two.versions[1]!.versionId);
  });

  it('keeps the version with what it places, once, and refuses one with assets', async () => {
    const { f, source } = await cadSource();
    const factory = await stored('factory', 'Line', f170SmallLine());
    const staged = stageFactoryLook(factory, source, f.assembly);
    expect(new Set(staged.factoryLooks!.map((p) => p.contentHash))).toEqual(
      new Set([cadContentHash(f.assembly), ...f.closure.keys()]),
    );
    // Again: nothing new to keep, the same record.
    expect(stageFactoryLook(staged, source, f.assembly)).toBe(staged);
    // A placed version the source does not keep.
    expect(() => stageFactoryLook(factory, { cadParts: [] }, f.assembly)).toThrow(/not kept/);
    const withAsset = {
      ...f.plate.content,
      assets: [{ id: 'x' }],
    } as unknown as CadDocument;
    expect(() => stageFactoryLook(factory, source, withAsset)).toThrow(/imported shapes/);
  });

  it('exports only what is named, and checks an import exactly', async () => {
    const { f, source } = await cadSource();
    const factory = stageFactoryLook(
      await stored('factory', 'Line', f170SmallLine()),
      source,
      f.pair.content,
    );
    // Kept but not yet named: a stored record may hold it, an export drops it.
    expect(() => validateFactoryLooks(factory, { stored: true })).not.toThrow();
    expect(() => validateFactoryLooks(factory)).toThrow(/not referenced/);
    expect(portableFactoryLooks(factory).factoryLooks).toBeUndefined();
    lookOn(factory, f.plate.contentHash);
    const out = portableFactoryLooks(factory);
    expect(out.factoryLooks!.map((p) => p.contentHash)).toEqual([f.plate.contentHash]);
    expect(() => validateFactoryLooks(out)).not.toThrow();
    // Named but not kept; a tampered version.
    lookOn(factory, f.pair.contentHash);
    expect(() => validateFactoryLooks({ ...factory, factoryLooks: out.factoryLooks })).toThrow(
      /missing/,
    );
    const bad = structuredClone(out.factoryLooks!);
    bad[0]!.content.partProperties.description = 'x';
    expect(() => validateFactoryLooks({ ...out, factoryLooks: bad })).toThrow(/hash mismatch/);
    expect(() =>
      validateFactoryLooks({
        ...out,
        factoryLooks: [out.factoryLooks![0]!, out.factoryLooks![0]!],
      }),
    ).toThrow(/duplicated/);
    // A kept version with imported shapes or textures (cannot be chosen, so not imported).
    const withAssets = structuredClone(out.factoryLooks![0]!.content);
    withAssets.assets = [
      {
        id: 'a-1',
        kind: 'source-step',
        sha256: `sha256:${'0'.repeat(64)}`,
        byteLength: 10,
        mediaType: 'model/step',
      },
    ];
    const asset = [{ contentHash: cadContentHash(withAssets), content: withAssets }];
    lookOn(out as StoredArtifact, asset[0]!.contentHash);
    expect(() => validateFactoryLooks({ ...out, factoryLooks: asset })).toThrow(/assets/);
  });

  it('a version save keeps the looks either side holds', async () => {
    const { f } = await cadSource();
    const a = [{ contentHash: f.plate.contentHash, content: f.plate.content }];
    const b = [{ contentHash: f.shaft.contentHash, content: f.shaft.content }];
    expect(mergeFactoryLooks({}, {})).toEqual({});
    expect(
      mergeFactoryLooks({ factoryLooks: a }, { factoryLooks: b }).factoryLooks!.map(
        (p) => p.contentHash,
      ),
    ).toEqual([f.shaft.contentHash, f.plate.contentHash]);
  });
});
