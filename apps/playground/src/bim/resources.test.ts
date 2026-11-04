import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { commitVersion, createArtifact, serializeArtifact } from '@editor-platform/artifact-core';
import { ReferenceResolver } from '@editor-platform/artifact-references';
import { applyBimOperation, bimStarter, type BimAssetRef } from '@editor-platform/bim-core';
import { nativeReferenceAdapters } from '@editor-platform/reference-adapters';
import { readImportFiles } from '../app/import-artifact';
import type { StoredArtifact } from '../model';
import {
  createCadAssetStore,
  encodeBytes,
  portableCadRecord,
  sha256Ref,
  validateCadRecord,
} from '../cad/resources';
import { assertBimNativeFits, portableBimRecord } from './parts';

/** A building keeps its materials' texture images beside its content, as CAD keeps assets (#662). */
const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const other = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9]);
async function refOf(bytes: Uint8Array, id = 'asset-1'): Promise<BimAssetRef> {
  return {
    id,
    kind: 'texture-png',
    sha256: await sha256Ref(bytes),
    byteLength: bytes.length,
    mediaType: 'image/png',
  };
}
const resource = (ref: BimAssetRef, bytes: Uint8Array) => ({
  kind: ref.kind,
  sha256: ref.sha256,
  byteLength: ref.byteLength,
  mediaType: ref.mediaType,
  encoding: 'base64' as const,
  bytes: encodeBytes(bytes),
});
async function building(): Promise<{ record: StoredArtifact; ref: BimAssetRef }> {
  const ref = await refOf(image);
  const doc = bimStarter();
  const m = doc.materials[0]!;
  const textured = applyBimOperation(doc, {
    type: 'update',
    collection: 'materials',
    entity: {
      ...m,
      appearance: {
        color: '#ffffff',
        opacity: 1,
        roughness: 1,
        metalness: 0,
        textures: {
          maps: { color: ref.id },
          sizeMm: [1000, 1000],
          rotationDeg: 0,
          normal: 'gl',
          name: 'Bricks',
        },
      },
    },
    assets: [ref],
  });
  const saved = await commitVersion(createArtifact('bim', 'Building', textured), null, 'v1');
  return {
    record: { ...saved, annotations: [], cadResources: [resource(ref, image)] } as never,
    ref,
  };
}
const context = () => ({
  exists: () => false,
  references: new ReferenceResolver(
    {
      list: async () => [],
      subscribe: () => () => {},
      read: async () => {
        throw new Error('No live reads during import');
      },
    },
    nativeReferenceAdapters,
  ),
});
const file = (r: StoredArtifact) =>
  new File([serializeArtifact(r)], 'b.artifact.json', { type: 'application/json' });

describe('building texture images in the Playground record (#662)', () => {
  it('carries exactly the images its draft and versions name, and checks them on import', async () => {
    const { record, ref } = await building();
    await expect(validateCadRecord(record)).resolves.toBeUndefined();
    const extra = await refOf(other, 'x');
    const kept = { ...record, cadResources: [...record.cadResources!, resource(extra, other)] };
    await expect(validateCadRecord(kept)).rejects.toThrow('CAD resource not referenced');
    expect(portableCadRecord(kept).cadResources).toEqual(record.cadResources);
    expect(portableBimRecord(portableCadRecord(kept)).cadResources).toEqual(record.cadResources);
    const [back] = await readImportFiles([file(record)], context());
    expect(back.cadResources).toEqual(record.cadResources);
    const broken = structuredClone(record);
    broken.cadResources![0]!.bytes = encodeBytes(other);
    await expect(readImportFiles([file(broken)], context())).rejects.toThrow('hash mismatch');
    const missing = structuredClone(record);
    delete missing.cadResources;
    await expect(readImportFiles([file(missing)], context())).rejects.toThrow(
      'CAD resource missing',
    );
    expect(ref.id).toBe('asset-1');
  });

  it('stores an image with the record first, and refuses one past the native file limit', async () => {
    const { record } = await building();
    let current: StoredArtifact = {
      ...record,
      draft: { ...record.draft, content: bimStarter() as never },
      versions: [],
      cadResources: [],
    };
    const store = createCadAssetStore({
      record: () => current,
      persist: async (next) => ((current = next), true),
      portable: (r) => portableBimRecord(portableCadRecord(r)),
    });
    const ref = await refOf(image);
    await store.stage([{ ref, bytes: image }]);
    expect(current.cadResources).toEqual([resource(ref, image)]);
    expect(store.get(ref.sha256)).toEqual(image);
    // An unnamed image is not carried, so it does not count against the limit…
    expect(() => assertBimNativeFits(current, 'export')).not.toThrow();
    // …but one too large to import is refused before it is stored.
    const huge = new Uint8Array(13_000_000);
    await expect(
      store.stage([{ ref: { ...(await refOf(huge)), id: 'big' }, bytes: huge }]),
    ).rejects.toThrow('16 MB');
  });
});
