/**
 * FT4c: the CAD part versions that give a factory's objects their look in 3D
 * (docs/cad/factory-twin.md). As with its building, the record keeps each named version's
 * content beside it, by hash, with the versions it places (its part closure): the factory shows
 * its machines on its own wherever the CAD Artifacts go.
 */
import { cadContentHash, isCadDocument, type CadDocument } from '@editor-platform/cad-core';
import type { FactoryDocument } from '@editor-platform/factory-core';
import type { StoredArtifact } from '../model';
import type { CadPartRecord } from '../cad/parts';

export interface FactoryLookChoice {
  artifactId: string;
  versionId: string;
  contentHash: string;
  label: string;
  content: CadDocument;
}

/** Every saved version of every CAD Artifact, newest version first (drafts never). */
export function factoryLookChoices(
  records: readonly Pick<StoredArtifact, 'id' | 'kind' | 'name' | 'versions'>[],
): FactoryLookChoice[] {
  return records
    .filter((r) => r.kind === 'cad' && r.versions.length)
    .flatMap((r) =>
      [...r.versions].reverse().map((v, i, all) => ({
        artifactId: r.id,
        versionId: v.versionId,
        contentHash: v.contentHash,
        label: `${r.name} — v${all.length - i}${v.reason ? ` (${v.reason})` : ''}`,
        content: v.content as unknown as CadDocument,
      })),
    );
}

/** The look hashes a factory document names. */
const named = (doc: FactoryDocument | undefined) =>
  (doc?.objects ?? [])
    .map((o) => o.look?.contentHash)
    .filter((h): h is string => typeof h === 'string');

/** The hashes the draft and versions name, with every version they place (nested). */
function closure(record: Pick<StoredArtifact, 'draft' | 'versions' | 'factoryLooks'>) {
  const kept = new Map((record.factoryLooks ?? []).map((p) => [p.contentHash, p.content]));
  const reached = new Set<string>();
  const missing = new Set<string>();
  const visit = (hash: string) => {
    if (reached.has(hash) || missing.has(hash)) return;
    const content = kept.get(hash);
    if (!content) return void missing.add(hash);
    reached.add(hash);
    for (const part of content.parts ?? []) visit(part.source.contentHash);
  };
  for (const d of [record.draft.content, ...record.versions.map((v) => v.content)])
    for (const h of named(d as unknown as FactoryDocument)) visit(h);
  return { reached, missing };
}

/**
 * The record with a CAD version (`content`, of `source`) kept as a look, with the versions it
 * places, before an edit names it. Imported shapes and textures (assets) are not kept: refused.
 */
export function stageFactoryLook<T extends Pick<StoredArtifact, 'factoryLooks'>>(
  record: T,
  source: Pick<StoredArtifact, 'cadParts'>,
  content: CadDocument,
): T {
  const sourceParts = new Map((source.cadParts ?? []).map((p) => [p.contentHash, p.content]));
  const add = new Map<string, CadDocument>();
  const visit = (hash: string, doc: CadDocument | undefined) => {
    if (add.has(hash)) return;
    if (!doc) throw new Error('A part this version places is not kept with it.');
    if (doc.assets.length)
      throw new Error('A version with imported shapes or textures cannot be a look.');
    add.set(hash, doc);
    for (const part of doc.parts ?? [])
      visit(part.source.contentHash, sourceParts.get(part.source.contentHash));
  };
  visit(cadContentHash(content), content);
  const kept = record.factoryLooks ?? [];
  const have = new Set(kept.map((p) => p.contentHash));
  const fresh = [...add].filter(([h]) => !have.has(h));
  if (!fresh.length) return record;
  return {
    ...record,
    factoryLooks: [
      ...kept,
      ...fresh.map(([contentHash, doc]) => ({ contentHash, content: structuredClone(doc) })),
    ],
  };
}

/** The record as exported: only the looks (and what they place) its draft and versions name. */
export function portableFactoryLooks<
  T extends Pick<StoredArtifact, 'kind' | 'draft' | 'versions' | 'factoryLooks'>,
>(record: T): T {
  if (record.kind !== 'factory' || !record.factoryLooks) return record;
  const { reached } = closure(record);
  const kept = record.factoryLooks.filter((p) => reached.has(p.contentHash));
  if (kept.length) return { ...record, factoryLooks: kept };
  const { factoryLooks: _, ...rest } = record;
  return rest as T;
}

/**
 * Native import and stored-record check: each kept version is valid CAD content under its own
 * hash, once, and every version the draft and versions name (and those place) is kept. An import
 * keeps exactly those; a stored record may keep more (`stored`).
 */
export function validateFactoryLooks(
  record: Pick<StoredArtifact, 'draft' | 'versions' | 'factoryLooks'>,
  { stored = false }: { stored?: boolean } = {},
) {
  const kept: CadPartRecord[] = record.factoryLooks ?? [];
  if (!Array.isArray(kept)) throw new Error('Factory looks');
  const hashes = new Set<string>();
  for (const p of kept) {
    if (
      !p ||
      typeof p !== 'object' ||
      Object.keys(p).sort().join() !== 'content,contentHash' ||
      typeof p.contentHash !== 'string'
    )
      throw new Error('Factory look');
    if (hashes.has(p.contentHash)) throw new Error('Factory look duplicated');
    hashes.add(p.contentHash);
    // As when chosen: imported shapes and textures are not kept with a factory.
    const assets = (p.content as { assets?: unknown } | null)?.assets;
    if (Array.isArray(assets) && assets.length) throw new Error('Factory look with assets');
    if (!isCadDocument(p.content)) throw new Error('Factory look content');
    if (cadContentHash(p.content) !== p.contentHash) throw new Error('Factory look hash mismatch');
  }
  const { reached, missing } = closure(record);
  if (missing.size) throw new Error('Factory look missing');
  if (!stored && reached.size !== hashes.size) throw new Error('Factory look not referenced');
}

/** A version save's record keeps every look either side holds. */
export function mergeFactoryLooks(
  saved: Pick<StoredArtifact, 'factoryLooks'>,
  latest: Pick<StoredArtifact, 'factoryLooks'>,
): Pick<StoredArtifact, 'factoryLooks'> {
  if (!saved.factoryLooks && !latest.factoryLooks) return {};
  const merged = [...(latest.factoryLooks ?? [])];
  for (const p of saved.factoryLooks ?? [])
    if (!merged.some((m) => m.contentHash === p.contentHash)) merged.push(p);
  return { factoryLooks: merged };
}
