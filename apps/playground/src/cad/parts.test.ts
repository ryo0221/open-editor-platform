import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { commitVersion, createArtifact, serializeArtifact } from '@editor-platform/artifact-core';
import { ReferenceResolver } from '@editor-platform/artifact-references';
import {
  applyCadOperation,
  cadContentHash,
  emptyCad,
  fixtureComponent,
  fixtureKernel,
  fixturePart,
  fixtureVersion,
  r2bParts,
  type CadDocument,
  type CadPartDef,
} from '@editor-platform/cad-core';
import { nativeReferenceAdapters } from '@editor-platform/reference-adapters';
import { readImportFiles } from '../app/import-artifact';
import type { StoredArtifact } from '../model';
import {
  cadPartClosure,
  createCadPartSource,
  createCadPartStore,
  mergeCadParts,
  validateCadParts,
} from './parts';
import { portableCadRecord, validateCadRecord } from './resources';

const stored = async (name: string, content: CadDocument, versions = 1) => {
  let a = createArtifact('cad', name, content);
  for (let i = 0; i < versions; i++) a = await commitVersion(a, null, `v${i + 1}`);
  return { ...a, annotations: [] } as unknown as StoredArtifact;
};
/** The r2b assembly saved with its whole closure kept. */
async function assemblyRecord() {
  const f = r2bParts();
  const record = await stored('Rig', f.assembly);
  record.cadParts = [...f.closure].map(([contentHash, content]) => ({ contentHash, content }));
  return { f, record };
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
  new File([serializeArtifact(r)], 'rig.artifact.json', { type: 'application/json' });

describe('retained part closure (R2b-1, CAD53)', () => {
  it('reaches nested versions and accepts an exact closure', async () => {
    const { f, record } = await assemblyRecord();
    const { reached, missing } = cadPartClosure(record);
    expect([...reached.keys()].sort()).toEqual([...f.closure.keys()].sort());
    expect(missing.size).toBe(0);
    await expect(validateCadRecord(record)).resolves.toBeUndefined();
  });

  it('refuses a missing, tampered, duplicated or unreferenced version', async () => {
    const { f, record } = await assemblyRecord();
    const cases: [(r: StoredArtifact) => void, string][] = [
      // The pair's plate is nested: dropping it is caught through the pair.
      [
        (r) => (r.cadParts = r.cadParts!.filter((p) => p.contentHash !== f.plate.contentHash)),
        'CAD part missing',
      ],
      [(r) => (r.cadParts![1]!.content.partProperties.description = 'x'), 'CAD part hash mismatch'],
      [(r) => r.cadParts!.push(structuredClone(r.cadParts![0]!)), 'CAD part duplicated'],
      [(r) => ((r.cadParts![0] as unknown as Record<string, unknown>).extra = 1), 'CAD part'],
      [
        (r) => ((r.cadParts![0]!.content as unknown as Record<string, unknown>).joints = 1),
        'CAD part content',
      ],
    ];
    for (const [edit, message] of cases) {
      const r = structuredClone(record);
      edit(r);
      expect(() => validateCadParts(r), message).toThrow(message);
    }
    const extra = structuredClone(record);
    const other = structuredClone(f.plate.content);
    other.partProperties.partNumber = 'P-2';
    extra.cadParts!.push({ contentHash: cadContentHash(other), content: other });
    expect(() => validateCadParts(extra)).toThrow('CAD part not referenced');
    // The portable file drops what nothing places, and then validates.
    await expect(validateCadRecord(portableCadRecord(extra))).resolves.toBeUndefined();
  });

  it('refuses a closure whose expansion exceeds the instance limit, though each file is small', async () => {
    const f = r2bParts();
    const many = (n: number, part: CadPartDef) =>
      Array.from({ length: n }, (_, i) => fixtureComponent(`c${i}`, part.id, [i * 100, 0, 0]));
    const leafPart = fixturePart('leaf', 'Plate', f.plate);
    const sub = applyCadOperation(emptyCad(fixtureKernel), {
      type: 'insertComponents',
      parts: [leafPart],
      components: many(100, leafPart),
    });
    const subV = fixtureVersion('sub', 'v1', sub);
    const subPart = fixturePart('sub', 'Sub', subV);
    const root = applyCadOperation(emptyCad(fixtureKernel), {
      type: 'insertComponents',
      parts: [subPart],
      components: many(101, subPart),
    });
    const record = await stored('Rig', root);
    record.cadParts = [
      { contentHash: subV.contentHash, content: sub },
      { contentHash: f.plate.contentHash, content: f.plate.content },
    ];
    // 101 sub-assemblies of 100 plates each is over 10,000 instances; 99 of them is not.
    expect(() => validateCadParts(record)).toThrow('CAD parts limit');
    record.draft.content = applyCadOperation(emptyCad(fixtureKernel), {
      type: 'insertComponents',
      parts: [subPart],
      components: many(99, subPart),
    }) as never;
    record.versions = [];
    expect(() => validateCadParts(record)).not.toThrow();
  });

  it('limits the versions each saved content reaches, not the record as a whole', async () => {
    const f = r2bParts();
    const variant = (i: number) => {
      const content = structuredClone(f.plate.content);
      content.partProperties.partNumber = `P-${i}`;
      return fixtureVersion(`plate-${i}`, 'v1', content);
    };
    const placing = (from: number, n: number) => {
      const versions = Array.from({ length: n }, (_, i) => variant(from + i));
      const parts = versions.map((v, i) => fixturePart(`p${i}`, `Plate ${i}`, v));
      const doc = applyCadOperation(emptyCad(fixtureKernel), {
        type: 'insertComponents',
        parts,
        components: parts.map((p, i) => fixtureComponent(`c${i}`, p.id, [i * 100, 0, 0])),
      });
      return { doc, versions };
    };
    // A saved version reaches 300, the draft 213 others: 513 kept in all.
    const saved = placing(0, 300);
    const draft = placing(300, 213);
    const record = await stored('Rig', saved.doc);
    record.draft.content = draft.doc as never;
    record.cadParts = [...saved.versions, ...draft.versions].map((v) => ({
      contentHash: v.contentHash,
      content: v.content,
    }));
    expect(record.cadParts).toHaveLength(513);
    expect(() => validateCadParts(record)).not.toThrow();
  });

  it('travels in the native file and opens after the part Artifacts are gone', async () => {
    const { record } = await assemblyRecord();
    const [back] = await readImportFiles([file(record)], context());
    expect(back.cadParts).toEqual(record.cadParts);
    const broken = structuredClone(record);
    broken.cadParts![0]!.content.parameters = [];
    await expect(readImportFiles([file(broken)], context())).rejects.toThrow('CAD part');
    const none = structuredClone(record);
    delete none.cadParts;
    await expect(readImportFiles([file(none)], context())).rejects.toThrow('CAD part missing');
  });

  it('stores staged versions before the edit names them, and merges with a newer record', async () => {
    const f = r2bParts();
    let current = await stored('Rig', structuredClone(f.assembly), 0);
    const assets: unknown[] = [];
    const store = createCadPartStore({
      record: () => current,
      persist: async (r) => ((current = r), true),
      stageAssets: async (a) => void assets.push(...a),
    });
    await store.stage([f.pair.content, f.plate.content], []);
    await store.stage([f.plate.content], []);
    expect(current.cadParts!.map((p) => p.contentHash)).toEqual([
      f.pair.contentHash,
      f.plate.contentHash,
    ]);
    expect(store.get(f.pair.contentHash)).toEqual(f.pair.content);
    expect(
      mergeCadParts({ cadParts: [current.cadParts![0]!] }, { cadParts: [current.cadParts![1]!] })
        .cadParts,
    ).toHaveLength(2);
    const failing = createCadPartStore({
      record: () => current,
      persist: async () => false,
      stageAssets: async () => {},
    });
    await expect(failing.stage([f.shaft.content], [])).rejects.toThrow('保存に失敗');
  });

  it('offers saved versions of other CAD Artifacts with their own closure', async () => {
    const f = r2bParts();
    const plate = await stored('Plate', f.plate.content, 2);
    const pair = await stored('Pair', f.pair.content);
    pair.cadParts = [{ contentHash: f.plate.contentHash, content: f.plate.content }];
    const draftOnly = await stored('Draft', f.shaft.content, 0);
    const opened: string[] = [];
    const source = createCadPartSource({
      records: () => [plate, pair, draftOnly],
      currentId: 'rig',
      open: (id) => void opened.push(id),
    });
    const list = await source.list();
    expect(list.map((c) => c.name)).toEqual(['Plate', 'Pair']);
    expect(list[0]!.versions.map((v) => v.label)).toEqual(['v2 — v2', 'v1 — v1']);
    const read = await source.readVersion(pair.id, pair.versions[0]!.versionId);
    expect(read.contentHash).toBe(f.pair.contentHash);
    expect(read.closure.map(cadContentHash)).toEqual([f.plate.contentHash]);
    await expect(source.readVersion(pair.id, 'nope')).rejects.toThrow('part-source-missing');
    source.open?.(plate.id, plate.versions[0]!.versionId);
    expect(opened).toEqual([plate.id]);
    expect(source.checkAccess('anything')).toBe(true);
    // R2b-2b: the newest saved version, with its label, only shown; a draft has none.
    expect(source.latestVersion?.(plate.id)).toEqual({
      versionId: plate.versions[1]!.versionId,
      contentHash: plate.versions[1]!.contentHash,
      label: 'v2 — v2',
    });
    expect(source.latestVersion?.(draftOnly.id)).toBeUndefined();
    // ST-85: a saved version reads by its number, not its ID.
    expect(source.versionLabel?.(plate.id, plate.versions[0]!.versionId)).toBe('v1');
    expect(source.versionLabel?.(plate.id, 'nope')).toBeUndefined();
  });
});
