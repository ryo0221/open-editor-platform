/**
 * FT4a: the Building versions a factory stands in (docs/cad/factory-twin.md). As a construction
 * schedule does, the record keeps each named version's content beside it, by hash, so the factory
 * shows and checks its building on its own wherever the Building Artifact goes.
 */
import { bimContentHash, isBimDocument, type BimDocument } from '@editor-platform/bim-core';
import type { FactoryDocument } from '@editor-platform/factory-core';
import type { StoredArtifact } from '../model';
import { constructionSourceChoices } from '../construction/source';

/** Every saved version of every Building Artifact, newest version first (drafts never). */
export const factorySourceChoices = (
  records: readonly Pick<StoredArtifact, 'id' | 'kind' | 'name' | 'versions'>[],
) => constructionSourceChoices(records);

/** The record with `content` kept as a source (by hash, once), before an edit names it. */
export function stageFactorySource<T extends Pick<StoredArtifact, 'factorySources'>>(
  record: T,
  content: BimDocument,
): T {
  const contentHash = bimContentHash(content);
  const kept = record.factorySources ?? [];
  if (kept.some((p) => p.contentHash === contentHash)) return record;
  return {
    ...record,
    factorySources: [...kept, { contentHash, content: structuredClone(content) }],
  };
}

const used = (record: Pick<StoredArtifact, 'draft' | 'versions'>) =>
  new Set(
    [record.draft.content, ...record.versions.map((v) => v.content)]
      .map((d) => (d as FactoryDocument | undefined)?.building?.contentHash)
      .filter((h): h is string => typeof h === 'string'),
  );

/** The record as exported: only the sources its draft and versions name. */
export function portableFactoryRecord<
  T extends Pick<StoredArtifact, 'kind' | 'draft' | 'versions' | 'factorySources'>,
>(record: T): T {
  if (record.kind !== 'factory' || !record.factorySources) return record;
  const names = used(record);
  const kept = record.factorySources.filter((p) => names.has(p.contentHash));
  if (kept.length) return { ...record, factorySources: kept };
  const { factorySources: _, ...rest } = record;
  return rest as T;
}

/**
 * Native import and stored-record check: each kept version is valid BIM content under its own
 * hash, once, and every version the draft and versions name is kept. An import keeps exactly
 * those; a stored record may also keep versions switched away from (`stored`).
 */
export function validateFactorySources(
  record: Pick<StoredArtifact, 'draft' | 'versions' | 'factorySources'>,
  { stored = false }: { stored?: boolean } = {},
) {
  const kept = record.factorySources ?? [];
  if (!Array.isArray(kept)) throw new Error('Factory sources');
  const hashes = new Set<string>();
  for (const p of kept) {
    if (
      !p ||
      typeof p !== 'object' ||
      Object.keys(p).sort().join() !== 'content,contentHash' ||
      typeof p.contentHash !== 'string'
    )
      throw new Error('Factory source');
    if (hashes.has(p.contentHash)) throw new Error('Factory source duplicated');
    hashes.add(p.contentHash);
    if (!isBimDocument(p.content)) throw new Error('Factory source content');
    if (bimContentHash(p.content) !== p.contentHash)
      throw new Error('Factory source hash mismatch');
  }
  const names = used(record);
  for (const h of names) if (!hashes.has(h)) throw new Error('Factory source missing');
  if (!stored && names.size !== hashes.size) throw new Error('Factory source not referenced');
}

/** The kept BIM content the document names, if the record keeps it. */
export const factorySourceOf = (
  record: Pick<StoredArtifact, 'factorySources'> | undefined,
  doc: FactoryDocument,
) =>
  doc.building
    ? record?.factorySources?.find((p) => p.contentHash === doc.building!.contentHash)?.content
    : undefined;

/** A version save's record keeps every Building version either side holds. */
export function mergeFactorySources(
  saved: Pick<StoredArtifact, 'factorySources'>,
  latest: Pick<StoredArtifact, 'factorySources'>,
): Pick<StoredArtifact, 'factorySources'> {
  if (!saved.factorySources && !latest.factorySources) return {};
  const merged = [...(latest.factorySources ?? [])];
  for (const p of saved.factorySources ?? [])
    if (!merged.some((m) => m.contentHash === p.contentHash)) merged.push(p);
  return { factorySources: merged };
}
