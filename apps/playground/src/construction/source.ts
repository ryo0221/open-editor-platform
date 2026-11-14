/**
 * CS1b: the BIM versions a construction schedule plans (docs/cad/construction-site.md, CS-U1:
 * one saved BIM version, fixed by version and content hash). The Playground keeps each scheduled
 * version's content beside the record, by hash, as a structural analysis keeps its CAD version.
 * The CAD parts a building places are not kept with the schedule: they show as boxes.
 */
import { bimContentHash, isBimDocument, type BimDocument } from '@editor-platform/bim-core';
import { newConstruction, type ConstructionDocument } from '@editor-platform/construction-core';
import type { StoredArtifact } from '../model';
import type { BimPartRecord } from '../character/parts';

/** One saved version of a Building Artifact a schedule can plan. */
export interface ConstructionSourceChoice {
  kind: 'construction';
  artifactId: string;
  versionId: string;
  /** For the picker: the Artifact's name and the version's place. */
  label: string;
  content: BimDocument;
}

/** Every saved version of every Building Artifact, newest version first. Drafts are never planned. */
export function constructionSourceChoices(
  records: readonly Pick<StoredArtifact, 'id' | 'kind' | 'name' | 'versions'>[],
): ConstructionSourceChoice[] {
  const out: ConstructionSourceChoice[] = [];
  for (const r of records) {
    if (r.kind !== 'bim') continue;
    for (let i = r.versions.length - 1; i >= 0; i--) {
      const v = r.versions[i]!;
      if (!isBimDocument(v.content)) continue;
      out.push({
        kind: 'construction',
        artifactId: r.id,
        versionId: v.versionId,
        label: `${r.name} · v${i + 1}`,
        content: v.content,
      });
    }
  }
  return out;
}

/** The other saved versions of the scheduled Building Artifact, newest first. */
export function constructionVersionChoices(
  records: readonly Pick<StoredArtifact, 'id' | 'kind' | 'name' | 'versions'>[],
  doc: ConstructionDocument,
): ConstructionSourceChoice[] {
  return constructionSourceChoices(records.filter((r) => r.id === doc.source.artifactId)).filter(
    (c) => c.versionId !== doc.source.versionId,
  );
}

/** Today in the browser's zone (YYYY-MM-DD), the start date of a new schedule. */
const today = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** A new schedule of the choice: no tasks, starting today, Monday to Saturday worked. */
export function newConstructionSchedule(
  choice: Pick<ConstructionSourceChoice, 'artifactId' | 'versionId' | 'content'>,
  name: string,
  startDate = today(),
): { doc: ConstructionDocument; retained: BimPartRecord } {
  const contentHash = bimContentHash(choice.content);
  const doc = newConstruction(
    name,
    { artifactId: choice.artifactId, versionId: choice.versionId, contentHash },
    startDate,
  );
  return { doc, retained: { contentHash, content: structuredClone(choice.content) } };
}

/** The record with `content` kept as a source (by hash, once), before an edit names it. */
export function stageConstructionSource<T extends Pick<StoredArtifact, 'constructionSources'>>(
  record: T,
  content: BimDocument,
): T {
  const contentHash = bimContentHash(content);
  const kept = record.constructionSources ?? [];
  if (kept.some((p) => p.contentHash === contentHash)) return record;
  return {
    ...record,
    constructionSources: [...kept, { contentHash, content: structuredClone(content) }],
  };
}

const roots = (record: Pick<StoredArtifact, 'draft' | 'versions'>) =>
  [record.draft.content, ...record.versions.map((v) => v.content)] as ConstructionDocument[];

/** The record as exported: only the sources its draft and versions plan. */
export function portableConstructionRecord<
  T extends Pick<StoredArtifact, 'kind' | 'draft' | 'versions' | 'constructionSources'>,
>(record: T): T {
  if (record.kind !== 'construction' || !record.constructionSources) return record;
  const used = new Set(roots(record).map((d) => d.source.contentHash));
  return {
    ...record,
    constructionSources: record.constructionSources.filter((p) => used.has(p.contentHash)),
  };
}

/**
 * Native import and stored-record check: each kept version is valid BIM content under its own
 * hash, once, and every version the draft and versions plan is kept. An import keeps exactly
 * those; a stored record may also keep versions switched away from (`stored`).
 */
export function validateConstructionSources(
  record: Pick<StoredArtifact, 'draft' | 'versions' | 'constructionSources'>,
  { stored = false }: { stored?: boolean } = {},
) {
  const kept = record.constructionSources ?? [];
  if (!Array.isArray(kept)) throw new Error('Construction sources');
  const hashes = new Set<string>();
  for (const p of kept) {
    if (
      !p ||
      typeof p !== 'object' ||
      Object.keys(p).sort().join() !== 'content,contentHash' ||
      typeof p.contentHash !== 'string'
    )
      throw new Error('Construction source');
    if (hashes.has(p.contentHash)) throw new Error('Construction source duplicated');
    hashes.add(p.contentHash);
    if (!isBimDocument(p.content)) throw new Error('Construction source content');
    if (bimContentHash(p.content) !== p.contentHash)
      throw new Error('Construction source hash mismatch');
  }
  const used = new Set(roots(record).map((d) => d.source.contentHash));
  for (const h of used) if (!hashes.has(h)) throw new Error('Construction source missing');
  if (!stored && used.size !== hashes.size) throw new Error('Construction source not referenced');
}

/** The kept BIM content a document plans, if the record keeps it. */
export const constructionSourceOf = (
  record: Pick<StoredArtifact, 'constructionSources'> | undefined,
  doc: ConstructionDocument,
) => record?.constructionSources?.find((p) => p.contentHash === doc.source.contentHash)?.content;

/** A version save's record keeps every scheduled BIM version either side holds. */
export function mergeConstructionSources(
  saved: Pick<StoredArtifact, 'constructionSources'>,
  latest: Pick<StoredArtifact, 'constructionSources'>,
): Pick<StoredArtifact, 'constructionSources'> {
  if (!saved.constructionSources && !latest.constructionSources) return {};
  const merged = [...(latest.constructionSources ?? [])];
  for (const p of saved.constructionSources ?? [])
    if (!merged.some((m) => m.contentHash === p.contentHash)) merged.push(p);
  return { constructionSources: merged };
}
