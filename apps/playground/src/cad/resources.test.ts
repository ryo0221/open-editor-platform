import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { commitVersion, createArtifact, serializeArtifact } from '@editor-platform/artifact-core';
import { ReferenceResolver } from '@editor-platform/artifact-references';
import { applyCadOperation, f01Empty, type CadDocument } from '@editor-platform/cad-core';
import { nativeReferenceAdapters } from '@editor-platform/reference-adapters';
import { readImportFiles } from '../app/import-artifact';
import type { StoredArtifact } from '../model';
import {
  assertCadNativeFits,
  cadNativeFileBytes,
  createCadAssetStore,
  decodeBytes,
  encodeBytes,
  mergeCadResources,
  portableCadRecord,
  sha256Ref,
  validateCadRecord,
  type CadResource,
} from './resources';

const step = new TextEncoder().encode('ISO-10303-21; a STEP file');
const brep = new TextEncoder().encode('DBRep_DrawableShape a BRep');
async function refs(stepBytes = step, brepBytes = brep) {
  return {
    step: {
      id: 'a-step',
      kind: 'source-step' as const,
      sha256: await sha256Ref(stepBytes),
      byteLength: stepBytes.length,
      mediaType: 'model/step',
    },
    brep: {
      id: 'a-brep',
      kind: 'normalized-brep' as const,
      sha256: await sha256Ref(brepBytes),
      byteLength: brepBytes.length,
      mediaType: 'model/x-occt-brep',
    },
  };
}
/** A CAD document with one imported body naming the two assets. */
async function imported(): Promise<CadDocument> {
  const r = await refs();
  return applyCadOperation(f01Empty(), {
    type: 'insertImportedBody',
    assets: [r.step, r.brep],
    feature: {
      id: 'imp',
      name: 'part.step',
      type: 'imported',
      inputFeatureIds: [],
      args: {
        kind: 'solid',
        sourceAssetId: 'a-step',
        brepAssetId: 'a-brep',
        importer: { id: 'k', buildHash: `sha256:${'c'.repeat(64)}` },
        sourceUnit: 'mm',
        scaleToMm: 1,
      },
    },
    body: {
      id: 'body',
      name: 'part',
      sourceFeatureId: 'imp',
      placementFeatureId: 'imp-placement',
      appearance: { color: '#888888', opacity: 1 },
    },
  });
}
const resource = (
  ref: { kind: CadResource['kind']; sha256: string; byteLength: number; mediaType: string },
  bytes: Uint8Array,
): CadResource => ({
  kind: ref.kind,
  sha256: ref.sha256,
  byteLength: ref.byteLength,
  mediaType: ref.mediaType,
  encoding: 'base64',
  bytes: encodeBytes(bytes),
});
async function record(): Promise<StoredArtifact> {
  const r = await refs();
  const saved = await commitVersion(createArtifact('cad', 'Part', await imported()), null, 'v1');
  return {
    ...saved,
    annotations: [],
    cadResources: [resource(r.step, step), resource(r.brep, brep)],
  } as StoredArtifact;
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
  new File([serializeArtifact(r)], 'part.artifact.json', { type: 'application/json' });

describe('CAD asset closure in the Playground record (CAD13, F08)', () => {
  it('accepts a record whose draft and versions resolve exactly', async () => {
    await expect(validateCadRecord(await record())).resolves.toBeUndefined();
  });

  it('refuses missing, altered, duplicated or unreferenced assets', async () => {
    const base = await record();
    const cases: [(r: StoredArtifact) => void, string][] = [
      [(r) => r.cadResources!.pop(), 'CAD resource missing'],
      [(r) => (r.cadResources![0].bytes = encodeBytes(brep)), 'CAD resource hash mismatch'],
      [(r) => (r.cadResources![0].bytes = '!!'), 'CAD resource encoding'],
      [(r) => r.cadResources!.push(structuredClone(r.cadResources![0])), 'CAD resource duplicated'],
      [(r) => (r.cadResources![1].mediaType = 'model/step'), 'CAD resource'],
      [
        (r) => r.cadResources!.push(resource({ ...r.cadResources![0], sha256: '' }, step)),
        'CAD resource hash mismatch',
      ],
      // The version still names the right size: the draft's wrong ref must not hide behind it.
      [
        (r) => ((r.draft.content as CadDocument).assets[1].byteLength += 1),
        'CAD resource does not match its ref',
      ],
    ];
    for (const [edit, message] of cases) {
      const r = structuredClone(base);
      edit(r);
      await expect(validateCadRecord(r), message).rejects.toThrow(message);
    }
    // Bytes kept only for this session's Undo are not part of the closure.
    const extra = structuredClone(base);
    const other = new Uint8Array([1, 2, 3]);
    extra.cadResources!.push(
      resource(
        {
          kind: 'source-step',
          sha256: await sha256Ref(other),
          byteLength: 3,
          mediaType: 'model/step',
        },
        other,
      ),
    );
    await expect(validateCadRecord(extra)).rejects.toThrow('CAD resource not referenced');
    await expect(validateCadRecord(portableCadRecord(extra))).resolves.toBeUndefined();
  });

  it('refuses a version or a native export whose file would no longer import', async () => {
    const base = await record();
    expect(() => assertCadNativeFits(base, 'version')).not.toThrow();
    // A record past 16 MB (versions or ordinary draft growth) is refused with its size, both
    // for a version save and for a native export, which also says how to recover.
    const big = { ...base, name: 'x'.repeat(cadNativeFileBytes) };
    expect(() => assertCadNativeFits(big, 'version')).toThrow('16 MB');
    expect(() => assertCadNativeFits(big, 'export')).toThrow('Undo');
  });

  it('a version keeps its assets after the draft deletes the body', async () => {
    const r = await record();
    r.draft = {
      ...r.draft,
      content: applyCadOperation(r.draft.content as CadDocument, {
        type: 'deleteClosure',
        ids: ['imp'],
        cascade: true,
      }),
    };
    expect((r.draft.content as CadDocument).assets).toEqual([]);
    expect(portableCadRecord(r).cadResources).toHaveLength(2);
    await expect(validateCadRecord(r)).resolves.toBeUndefined();
  });

  it('round-trips through a native file and refuses one with an altered asset', async () => {
    const r = await record();
    const [back] = await readImportFiles([file(r)], context());
    expect(back.cadResources).toEqual(r.cadResources);
    expect(back.versions[0].contentHash).toBe(r.versions[0].contentHash);
    const broken = structuredClone(r);
    broken.cadResources![1].bytes = encodeBytes(new TextEncoder().encode('another BRep'));
    await expect(readImportFiles([file(broken)], context())).rejects.toThrow('hash mismatch');
    const missing = structuredClone(r);
    delete missing.cadResources;
    await expect(readImportFiles([file(missing)], context())).rejects.toThrow(
      'CAD resource missing',
    );
  });
});

describe('createCadAssetStore', () => {
  async function setup(saved = true) {
    const base = await record();
    let current: StoredArtifact = { ...base, cadResources: [] };
    current.draft = { ...current.draft, content: f01Empty() };
    current.versions = [];
    const persisted: StoredArtifact[] = [];
    const store = createCadAssetStore({
      record: () => current,
      persist: async (next) => {
        persisted.push(next);
        if (saved) current = next;
        return saved;
      },
    });
    return { store, persisted, get: () => current, set: (r: StoredArtifact) => (current = r) };
  }

  it('saves the bytes with the record before the content names them', async () => {
    const { store, persisted, get } = await setup();
    const r = await refs();
    await store.stage([
      { ref: r.step, bytes: step },
      { ref: r.brep, bytes: brep },
    ]);
    expect(persisted).toHaveLength(1);
    expect(get().cadResources!.map((x) => x.kind)).toEqual(['source-step', 'normalized-brep']);
    expect(store.get(r.brep.sha256)).toEqual(brep);
    // Staging the same file again keeps one copy.
    await store.stage([{ ref: r.step, bytes: step }]);
    expect(get().cadResources).toHaveLength(2);
  });

  it('refuses bytes that do not match the ref, a save that failed, and a file over 16 MB', async () => {
    const { store, get } = await setup();
    const r = await refs();
    await expect(store.stage([{ ref: r.step, bytes: brep }])).rejects.toThrow('一致しません');
    expect(get().cadResources).toEqual([]);
    const failing = await setup(false);
    await expect(failing.store.stage([{ ref: r.step, bytes: step }])).rejects.toThrow(
      '保存に失敗しました',
    );
    expect(failing.get().cadResources).toEqual([]);
    // 12 MB of bytes is 16 MB as base64: the native file would no longer import.
    const big = new Uint8Array(12_000_000);
    const ref = { ...r.step, sha256: await sha256Ref(big), byteLength: big.length };
    await expect(store.stage([{ ref, bytes: big }])).rejects.toThrow('16 MB');
    expect(get().cadResources).toEqual([]);
    expect(cadNativeFileBytes).toBe(16_000_000);
  });

  it('decodes a 6 MB asset without growing the stack, and refuses malformed text', () => {
    const big = new Uint8Array(6_000_000).map((_, i) => i % 251);
    const text = encodeBytes(big);
    // Compared as buffers: a deep equality over 6 M elements would take most of a minute.
    expect(Buffer.from(decodeBytes(text)).equals(Buffer.from(big))).toBe(true);
    for (const bad of [
      text.slice(1),
      `${text.slice(0, -4)}A=A=`,
      `${text.slice(0, -4)}====`,
      'QQ=',
    ])
      expect(() => decodeBytes(bad)).toThrow('CAD resource encoding');
  });

  it('a version saved while an asset is staged keeps the staged asset', async () => {
    const { store, get } = await setup();
    const r = await refs();
    const committed = get();
    await store.stage([{ ref: r.step, bytes: step }]);
    const merged = mergeCadResources(committed, get()).cadResources!;
    expect(merged.map((x) => x.sha256)).toEqual([r.step.sha256]);
    // Nothing the version names is dropped either.
    expect(mergeCadResources(get(), { ...get(), cadResources: [] }).cadResources).toHaveLength(1);
    expect(
      mergeCadResources(
        { ...get(), cadResources: undefined },
        { ...get(), cadResources: undefined },
      ),
    ).toEqual({});
  });

  it('adds to the record as it is after hashing, so a newer draft is kept', async () => {
    const { store, get, set } = await setup();
    const r = await refs();
    const staging = store.stage([{ ref: r.step, bytes: step }]);
    const newer = { ...get(), name: 'Renamed while hashing' };
    set(newer);
    await staging;
    expect(get().name).toBe('Renamed while hashing');
    expect(get().cadResources).toHaveLength(1);
  });
});
