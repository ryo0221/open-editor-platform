import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { commitVersion, createArtifact } from '@editor-platform/artifact-core';
import { bimStarter, type BimDocument, type BimType } from '@editor-platform/bim-core';
import type { BimPartReference } from '@editor-platform/bim';
import { f02Plate, type CadDocument } from '@editor-platform/cad-core';
import type { StoredArtifact } from '../model';
import { readIfcImport } from './import-artifact';

/**
 * The Playground's IFC import against its own CAD versions (R2c-6): the file's reader is replaced
 * by one that returns what `readIfc` returns for a file whose parts' elements were dropped.
 */
/** The native file limit, lowered for one test. */
const native = vi.hoisted(() => ({ limit: undefined as number | undefined }));
vi.mock('../cad/resources', async (original) => {
  const actual = await original<typeof import('../cad/resources')>();
  return {
    ...actual,
    get cadNativeFileBytes() {
      return native.limit ?? actual.cadNativeFileBytes;
    },
  };
});
const read = vi.hoisted(() => ({
  document: undefined as unknown,
  losses: [] as { entity: string; reason: string }[],
}));
vi.mock('@editor-platform/bim/ifc-import', () => ({
  readBimIfcFile: async (
    _file: Blob,
    options: { resolvePart?(s: BimPartReference): boolean; acceptLoss?: boolean },
  ) => {
    const doc = structuredClone(read.document) as BimDocument;
    // Like `readIfc`: only the types that elements place reach the resolver.
    for (const e of doc.elements)
      if (e.kind === 'part') {
        const t = doc.types.find((x) => x.id === e.typeId);
        if (t?.kind === 'part') options.resolvePart?.(t.source);
      }
    const report = {
      restored: doc.elements.length,
      withoutFollow: 0,
      losses: read.losses,
      summary: read.losses.map((l) => ({ ...l, count: 1 })),
    };
    if (read.losses.length && !options.acceptLoss) return { status: 'needs-confirmation', report };
    return { status: 'imported', document: doc, report };
  },
}));

const cad = async (name: string) => {
  const a = await commitVersion(createArtifact('cad', name, f02Plate() as CadDocument), null, 'v1');
  return { ...a, annotations: [] } as unknown as StoredArtifact;
};
const partType = (id: string, source: BimPartReference): BimType => ({
  id,
  kind: 'part',
  name: id,
  source,
  hintBounds: { min: [0, 0, 0], max: [1, 1, 1] },
});
const refOf = (r: StoredArtifact): BimPartReference => ({
  artifactId: r.id,
  versionId: r.versions[0]!.versionId,
  contentHash: r.versions[0]!.contentHash,
});

describe('importing an IFC file into the Playground (R2c-6)', () => {
  it('lists a part type whose version is not here, and drops it once confirmed', async () => {
    const plate = await cad('Plate');
    const missing: BimPartReference = {
      artifactId: 'cad-elsewhere',
      versionId: 'v9',
      contentHash: 'f'.repeat(64),
    };
    const doc = bimStarter();
    // A type kept after its elements were dropped, and a type no element places.
    doc.types.push(partType('pt-missing', missing), partType('pt-unused', refOf(plate)));
    read.document = doc;
    read.losses = [];
    const file = new File(['ISO-10303-21;'], 'Office.ifc');
    const context = { records: () => [plate] };

    const first = await readIfcImport(file, context);
    expect(first.status).toBe('needs-confirmation');
    if (first.status !== 'needs-confirmation') return;
    expect(first.report.summary).toEqual([
      { entity: 'part type', reason: 'part-unresolved', count: 1 },
    ]);
    expect(first.report.losses).toEqual([
      { entity: 'part type', reason: 'part-unresolved', name: 'pt-missing' },
    ]);

    const done = await readIfcImport(file, { ...context, acceptLoss: true });
    expect(done.status).toBe('imported');
    if (done.status !== 'imported') return;
    const types = (done.record.draft.content as unknown as BimDocument).types;
    expect(types.map((t) => t.id)).not.toContain('pt-missing');
    expect(types.map((t) => t.id)).toContain('pt-unused');
    // The unused type's version is kept with the building, as a placed one is.
    expect(done.record.cadParts?.map((p) => p.contentHash)).toEqual([refOf(plate).contentHash]);
    expect(done.record.name).toBe('Office');
  });

  it("lists an unresolved type together with the reader's own losses before asking", async () => {
    const doc = bimStarter();
    doc.types.push(
      partType('pt-missing', { artifactId: 'cad-x', versionId: 'v1', contentHash: 'e'.repeat(64) }),
    );
    read.document = doc;
    read.losses = [{ entity: 'IFCDOOR', reason: 'not-in-subset' }];
    const file = new File(['ISO-10303-21;'], 'Office.ifc');
    const first = await readIfcImport(file, { records: () => [] });
    expect(first.status).toBe('needs-confirmation');
    if (first.status !== 'needs-confirmation') return;
    expect(first.report.summary).toEqual([
      { entity: 'IFCDOOR', reason: 'not-in-subset', count: 1 },
      { entity: 'part type', reason: 'part-unresolved', count: 1 },
    ]);
  });

  it('refuses an import whose kept CAD versions would pass the native file limit', async () => {
    const [one, two] = [await cad('Plate'), await cad('Plate 2')];
    const doc = bimStarter();
    doc.types.push(partType('pt-1', refOf(one)), partType('pt-2', refOf(two)));
    read.document = doc;
    read.losses = [];
    const file = new File(['ISO-10303-21;'], 'Office.ifc');
    // A limit just under the native file of the building with its kept version.
    const once = await readIfcImport(file, { records: () => [one, two] });
    if (once.status !== 'imported') throw new Error(once.status);
    const size = new Blob([JSON.stringify(once.record)]).size;
    native.limit = size - 1;
    try {
      await expect(readIfcImport(file, { records: () => [one, two] })).rejects.toThrow(
        '取り込みません',
      );
    } finally {
      native.limit = undefined;
    }
  });
});
