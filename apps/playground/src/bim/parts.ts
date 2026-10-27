/**
 * The Playground's part source for buildings (docs/cad/r2c-architecture.md, version reference;
 * R2c-U2): the saved versions of its `cad` Artifacts. A version placed in a building is kept in
 * the building's record (`cadParts`, its retained closure, as an assembly keeps its parts) and
 * travels in its native file, so the building still reads it after the CAD Artifact changes or
 * is deleted. Shapes are evaluated here, with the Host's CAD kernel build, into the normalized
 * BRep the building's kernel reads; the bim package never sees a CAD document.
 */
import { cadContentHash, isCadDocument, type CadDocument } from '@editor-platform/cad-core';
import type { CadBrepExport } from '@editor-platform/cad-kernel-occt';
import type { BimPartReference, BimPartShape, BimPartSource } from '@editor-platform/bim';
import { isBimDocument, type BimDocument } from '@editor-platform/bim-core';
import type { StoredArtifact } from '../model';
import type { CadPartRecord } from '../cad/parts';
import { cadNativeFileBytes, nativeBytes } from '../cad/resources';

/** What the source needs of a CAD kernel: one exact document written as BRep. */
export interface BimPartKernel {
  buildHash: string;
  exportBrep(document: CadDocument, contentHash: string): Promise<CadBrepExport>;
}

export function createBimPartSource(options: {
  records(): StoredArtifact[];
  /** The building's own record, which keeps the placed versions. */
  record(): StoredArtifact | undefined;
  persist(record: StoredArtifact): Promise<boolean>;
  kernel: BimPartKernel | undefined;
}): BimPartSource {
  const shapes = new Map<string, Promise<BimPartShape>>();
  /** The version's content: kept with the building first, else its CAD Artifact's version. */
  const content = (source: BimPartReference) => {
    const kept = options.record()?.cadParts?.find((p) => p.contentHash === source.contentHash);
    if (kept) return kept.content;
    const record = options.records().find((r) => r.id === source.artifactId && r.kind === 'cad');
    const version = record?.versions.find((v) => v.versionId === source.versionId);
    if (!version || version.contentHash !== source.contentHash) return undefined;
    return version.content as unknown as CadDocument;
  };
  const read = async (source: BimPartReference): Promise<BimPartShape> => {
    const doc = content(source);
    if (!doc) throw new Error('part-source-missing');
    // A version that places parts or reads imported files needs its own closure; not yet.
    if (doc.parts?.length) throw new Error('part-assembly-unsupported');
    if (doc.assets.length) throw new Error('part-assets-unsupported');
    const kernel = options.kernel;
    if (!kernel) throw new Error('kernel-build-unavailable');
    // One build for the building and every part (R2b-U6).
    if (doc.kernelProfile.buildHash !== kernel.buildHash) throw new Error('part-build-mismatch');
    const brep = await kernel.exportBrep(doc, source.contentHash);
    return {
      brep: brep.bytes,
      bounds: brep.bounds,
      kinds: brep.kinds,
      looks: brep.appearances,
      faces: brep.faces,
    };
  };
  return {
    async list() {
      return options
        .records()
        .filter((r) => r.kind === 'cad' && r.versions.length)
        .map((r) => ({
          artifactId: r.id,
          name: r.name,
          versions: [...r.versions].reverse().map((v, i, all) => ({
            versionId: v.versionId,
            label: `v${all.length - i}${v.reason ? ` — ${v.reason}` : ''}`,
            contentHash: v.contentHash,
          })),
        }));
    },
    shape(source) {
      let shape = shapes.get(source.contentHash);
      if (!shape) {
        shape = read(source);
        // A failure is not kept: the next read tries again.
        shape.catch(() => shapes.delete(source.contentHash));
        shapes.set(source.contentHash, shape);
      }
      return shape;
    },
    async retain(source) {
      const record = options.record();
      const doc = content(source);
      if (!record || !doc) throw new Error('part-source-missing');
      if (record.cadParts?.some((p) => p.contentHash === source.contentHash)) return;
      const cadParts = [
        ...(record.cadParts ?? []),
        { contentHash: source.contentHash, content: doc },
      ];
      // The native file must still import with this version in it (the type names it next).
      const portable = portableBimRecord(record);
      const next = { ...portable, cadParts: [...(portable.cadParts ?? []), cadParts.at(-1)!] };
      if (nativeBytes(next) > cadNativeFileBytes) throw new Error('part-file-too-large');
      if (!(await options.persist({ ...record, cadParts }))) throw new Error('part-retain-failed');
    },
  };
}

const roots = (record: Pick<StoredArtifact, 'draft' | 'versions'>) =>
  [record.draft.content, ...record.versions.map((v) => v.content)] as unknown as BimDocument[];
/** The CAD versions a building's draft and versions place, by content hash. */
export function bimPartHashes(record: Pick<StoredArtifact, 'draft' | 'versions'>) {
  const hashes = new Set<string>();
  for (const doc of roots(record))
    for (const t of doc.types) if (t.kind === 'part') hashes.add(t.source.contentHash);
  return hashes;
}

/**
 * The record a building's native file carries: the part versions its draft and versions place,
 * nothing else (a type removed by an edit leaves its version local only).
 */
export function portableBimRecord(record: StoredArtifact): StoredArtifact {
  if (record.kind !== 'bim' || !record.cadParts) return record;
  const placed = bimPartHashes(record);
  return { ...record, cadParts: record.cadParts.filter((p) => placed.has(p.contentHash)) };
}

/**
 * A building whose native file would no longer import is refused before a version is saved and
 * before a native export is downloaded (the versions it keeps count), as for CAD.
 */
export function assertBimNativeFits(
  record: StoredArtifact,
  action: 'version' | 'export' | 'import',
) {
  if (record.kind !== 'bim') return;
  const size = nativeBytes(portableBimRecord(record));
  if (size <= cadNativeFileBytes) return;
  const mb = `native fileが${(size / 1e6).toFixed(1)} MBになり、上限の16 MBを超えます`;
  throw new Error(
    action === 'version'
      ? `Versionを保存すると${mb}。保存しません。下書きは保持しています。`
      : action === 'import'
        ? `部品の版を含めると${mb}。取り込みません。`
        : `${mb}。読み戻せないfileになるため書き出しません。部品の型を減らすと書き出せます。下書きは保持しています。`,
  );
}

/**
 * Native import check: each kept version is valid CAD content under its own hash, once, and the
 * closure is exact (every placed version is kept, nothing else is).
 */
export function validateBimParts(record: StoredArtifact) {
  const parts: CadPartRecord[] = record.cadParts ?? [];
  if (!Array.isArray(parts)) throw new Error('Building parts');
  const seen = new Set<string>();
  for (const p of parts) {
    if (
      !p ||
      typeof p !== 'object' ||
      Object.keys(p).sort().join() !== 'content,contentHash' ||
      typeof p.contentHash !== 'string'
    )
      throw new Error('Building part');
    if (seen.has(p.contentHash)) throw new Error('Building part duplicated');
    seen.add(p.contentHash);
    if (!isCadDocument(p.content)) throw new Error('Building part content');
    if (cadContentHash(p.content) !== p.contentHash) throw new Error('Building part hash mismatch');
  }
  if (!roots(record).every(isBimDocument)) return;
  const placed = bimPartHashes(record);
  for (const h of placed) if (!seen.has(h)) throw new Error('Building part missing');
  if (seen.size !== placed.size) throw new Error('Building part not referenced');
}
