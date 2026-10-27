import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { commitVersion, createArtifact } from '@editor-platform/artifact-core';
import { bimStarter, type BimDocument } from '@editor-platform/bim-core';
import type { BimPartReference } from '@editor-platform/bim';
import { cadContentHash, f02Plate, r2bParts, type CadDocument } from '@editor-platform/cad-core';
import type { CadBrepExport } from '@editor-platform/cad-kernel-occt';
import type { StoredArtifact } from '../model';
import {
  assertBimNativeFits,
  bimPartHashes,
  createBimPartSource,
  portableBimRecord,
  validateBimParts,
  type BimPartKernel,
} from './parts';

/** The Playground's part source for buildings: its saved CAD versions (R2c-3c-3b). */
const stored = async (kind: 'cad' | 'bim', name: string, content: object, versions = 1) => {
  let a = createArtifact(kind, name, content as CadDocument);
  for (let i = 0; i < versions; i++) a = await commitVersion(a, null, `v${i + 1}`);
  return { ...a, annotations: [] } as unknown as StoredArtifact;
};
const plate = (): CadDocument => f02Plate();
const exported: CadBrepExport = {
  bytes: new Uint8Array([1]),
  bounds: [
    [0, 0, 0],
    [100, 50, 10],
  ],
  kinds: ['solid'],
  appearances: [{ color: '#f2efe6', opacity: 1 }],
  faces: [6],
};
function kernel(buildHash = plate().kernelProfile.buildHash) {
  const calls: string[] = [];
  const k: BimPartKernel = {
    buildHash,
    exportBrep: async (_doc, hash) => (calls.push(hash), exported),
  };
  return { k, calls };
}
const refOf = (r: StoredArtifact, i = 0): BimPartReference => ({
  artifactId: r.id,
  versionId: r.versions[i]!.versionId,
  contentHash: r.versions[i]!.contentHash,
});
const withPart = (doc: BimDocument, source: BimPartReference): BimDocument => ({
  ...doc,
  types: [
    ...doc.types,
    {
      id: 'pt-1',
      kind: 'part',
      name: 'Plate',
      source,
      hintBounds: { min: [0, 0, 0], max: [1, 1, 1] },
    },
  ],
});

describe('bim part source (R2c-3c-3b)', () => {
  it('lists saved CAD versions newest first, reads a shape once and keeps the version', async () => {
    const cad = await stored('cad', 'Plate', plate(), 2);
    const unsaved = { ...(await stored('cad', 'Draft', plate(), 0)) };
    let building = await stored('bim', 'Building', bimStarter(), 0);
    const { k, calls } = kernel();
    const persisted: StoredArtifact[] = [];
    const source = createBimPartSource({
      records: () => [cad, unsaved, building],
      record: () => building,
      persist: async (r) => (persisted.push(r), (building = r), true),
      kernel: k,
    });
    const list = await source.list();
    expect(list.map((c) => c.name)).toEqual(['Plate']);
    expect(list[0]!.versions.map((v) => v.label)).toEqual(['v2 — v2', 'v1 — v1']);
    expect(list[0]!.versions[0]!.versionId).toBe(cad.versions[1]!.versionId);
    const ref = refOf(cad);
    expect(ref.contentHash).toBe(cadContentHash(cad.versions[0]!.content as never));
    const [a, b] = await Promise.all([source.shape(ref), source.shape(ref)]);
    expect(a).toEqual({
      brep: exported.bytes,
      bounds: exported.bounds,
      kinds: ['solid'],
      looks: exported.appearances,
      faces: exported.faces,
    });
    expect(b).toBe(a);
    expect(calls).toEqual([ref.contentHash]);
    await source.retain(ref);
    await source.retain(ref);
    expect(persisted).toHaveLength(1);
    expect(building.cadParts).toEqual([
      { contentHash: ref.contentHash, content: cad.versions[0]!.content },
    ]);
  });

  it('reads a kept version after its CAD Artifact is gone, and names each refusal', async () => {
    const cad = await stored('cad', 'Plate', plate());
    const ref = refOf(cad);
    const building = await stored('bim', 'Building', bimStarter(), 0);
    building.cadParts = [
      { contentHash: ref.contentHash, content: cad.versions[0]!.content as never },
    ];
    const reject = (s: ReturnType<typeof createBimPartSource>, r = ref) =>
      s.shape(r).then(
        () => 'read',
        (e: Error) => e.message,
      );
    const kept = createBimPartSource({
      records: () => [building],
      record: () => building,
      persist: async () => true,
      kernel: kernel().k,
    });
    expect(await reject(kept)).toBe('read');
    const bare = { records: () => [cad], record: () => undefined, persist: async () => true };
    // A version whose hash is not the one named, or that is not saved.
    expect(
      await reject(createBimPartSource({ ...bare, kernel: kernel().k }), {
        ...ref,
        contentHash: 'b'.repeat(64),
      }),
    ).toBe('part-source-missing');
    expect(await reject(createBimPartSource({ ...bare, kernel: undefined }))).toBe(
      'kernel-build-unavailable',
    );
    expect(
      await reject(createBimPartSource({ ...bare, kernel: kernel(`sha256:${'1'.repeat(64)}`).k })),
    ).toBe('part-build-mismatch');
    const assembly = await stored('cad', 'Rig', r2bParts().assembly);
    const imported = await stored('cad', 'Step', { ...plate(), assets: [{ id: 'x' }] });
    const of = (r: StoredArtifact) =>
      reject(
        createBimPartSource({
          records: () => [r],
          record: () => undefined,
          persist: async () => true,
          kernel: kernel().k,
        }),
        refOf(r),
      );
    expect(await of(assembly)).toBe('part-assembly-unsupported');
    expect(await of(imported)).toBe('part-assets-unsupported');
    // A failure is not kept: the next read tries again.
    const held: { k?: BimPartKernel } = {};
    const late = createBimPartSource({
      ...bare,
      get kernel() {
        return held.k;
      },
    });
    expect(await reject(late)).toBe('kernel-build-unavailable');
    held.k = kernel().k;
    expect(await reject(late)).toBe('read');
    await expect(createBimPartSource({ ...bare, kernel: held.k }).retain(ref)).rejects.toThrow(
      'part-source-missing',
    );
  });

  it('carries exactly the placed versions in the native file and checks them on import', async () => {
    const cad = await stored('cad', 'Plate', plate());
    const other = await stored('cad', 'Edge', f02Plate('edge'));
    const ref = refOf(cad);
    const record = await stored('bim', 'Building', withPart(bimStarter(), ref));
    const keep = (i: number) => {
      const v = [cad, other][i]!.versions[0]!;
      return { contentHash: v.contentHash, content: v.content as never };
    };
    record.cadParts = [keep(0), keep(1)];
    expect([...bimPartHashes(record)]).toEqual([ref.contentHash]);
    const portable = portableBimRecord(record);
    expect(portable.cadParts).toEqual([keep(0)]);
    expect(() => validateBimParts(portable)).not.toThrow();
    expect(() => validateBimParts(record)).toThrow('Building part not referenced');
    expect(() => validateBimParts({ ...record, cadParts: [] })).toThrow('Building part missing');
    expect(() => validateBimParts({ ...record, cadParts: [keep(0), keep(0)] })).toThrow(
      'Building part duplicated',
    );
    expect(() =>
      validateBimParts({ ...record, cadParts: [{ ...keep(0), contentHash: keep(1).contentHash }] }),
    ).toThrow('Building part hash mismatch');
    expect(() =>
      validateBimParts({ ...record, cadParts: [{ ...keep(0), extra: 1 } as never] }),
    ).toThrow('Building part');
  });

  it('keeps no version that would make the native file too large to import', async () => {
    const big = { ...plate(), parameters: [], description: 'x'.repeat(9_000_000) } as never;
    const one = await stored('cad', 'Big', big);
    const two = await stored('cad', 'Big 2', {
      ...(big as object),
      description: 'y'.repeat(9_000_000),
    });
    let building = await stored('bim', 'Building', bimStarter(), 0);
    const source = createBimPartSource({
      records: () => [one, two, building],
      record: () => building,
      persist: async (r) => ((building = r), true),
      kernel: kernel().k,
    });
    await source.retain(refOf(one));
    // The first kept version is placed; the second would pass 16 MB.
    building = {
      ...building,
      draft: { ...building.draft, content: withPart(bimStarter(), refOf(one)) as never },
    };
    await expect(source.retain(refOf(two))).rejects.toThrow('part-file-too-large');
    expect(building.cadParts).toHaveLength(1);
    expect(() => assertBimNativeFits(building, 'export')).not.toThrow();
    const both = {
      ...building,
      draft: {
        ...building.draft,
        content: {
          ...withPart(bimStarter(), refOf(one)),
          types: [
            ...withPart(bimStarter(), refOf(one)).types,
            { ...withPart(bimStarter(), refOf(two)).types.at(-1)!, id: 'pt-2' },
          ],
        } as never,
      },
      cadParts: [
        ...building.cadParts!,
        { contentHash: refOf(two).contentHash, content: two.versions[0]!.content as never },
      ],
    };
    expect(() => assertBimNativeFits(both, 'export')).toThrow('16 MB');
    expect(() => assertBimNativeFits(both, 'version')).toThrow('Versionを保存すると');
  });
});
