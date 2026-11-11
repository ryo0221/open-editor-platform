/**
 * The versions a character keeps for its props, by content hash in its record: CAD versions in
 * `cadParts` (C2b-3) and BIM versions in `bimParts` (C8p), with the CAD versions a building
 * places in `cadParts` too. The closure its draft and versions reach, carried in its native file.
 */
import { bimContentHash, isBimDocument, type BimDocument } from '@editor-platform/bim-core';
import { cadContentHash, isCadDocument, type CadDocument } from '@editor-platform/cad-core';
import type { CharacterDocument } from '@editor-platform/character-core';
import type { StoredArtifact } from '../model';
import type { CharacterPropChoice } from '@editor-platform/character';
import type { CadPartRecord } from '../cad/parts';
import { cadNativeFileBytes, nativeBytes, portableCadRecord } from '../cad/resources';

/** One BIM version kept with a character (C8p): its content and the hash it is named by. */
export interface BimPartRecord {
  contentHash: string;
  content: BimDocument;
}

/**
 * The buildings a character keeps, after a version save: those retained while the save ran
 * stay (the record only gains them), as `mergeCadParts` does for CAD versions.
 */
export function mergeBimParts(
  saved: { bimParts?: BimPartRecord[] },
  latest: { bimParts?: BimPartRecord[] },
): { bimParts?: BimPartRecord[] } {
  if (!saved.bimParts && !latest.bimParts) return {};
  const merged = [...(latest.bimParts ?? [])];
  for (const p of saved.bimParts ?? [])
    if (!merged.some((m) => m.contentHash === p.contentHash)) merged.push(p);
  return { bimParts: merged };
}

const roots = (record: Pick<StoredArtifact, 'draft' | 'versions'>) =>
  [
    record.draft.content,
    ...record.versions.map((v) => v.content),
  ] as unknown as CharacterDocument[];

/**
 * The versions a character's draft and versions place as props, and every version those place
 * in turn, by content hash, from what the record keeps. Hashes it does not keep are `missing`.
 */
export function characterPartClosure(
  record: Pick<StoredArtifact, 'draft' | 'versions' | 'cadParts' | 'bimParts'>,
) {
  const kept = new Map((record.cadParts ?? []).map((p) => [p.contentHash, p.content]));
  const keptBim = new Map((record.bimParts ?? []).map((p) => [p.contentHash, p.content]));
  const reached = new Map<string, CadDocument>();
  const reachedBim = new Map<string, BimDocument>();
  const missing = new Set<string>();
  const visit = (hash: string) => {
    if (reached.has(hash) || missing.has(hash)) return;
    const content = kept.get(hash);
    if (!content) return void missing.add(hash);
    reached.set(hash, content);
    for (const part of content.parts ?? []) visit(part.source.contentHash);
  };
  const visitBim = (hash: string) => {
    if (reachedBim.has(hash) || missing.has(hash)) return;
    const content = keptBim.get(hash);
    if (!content) return void missing.add(hash);
    reachedBim.set(hash, content);
    for (const t of content.types ?? []) if (t.kind === 'part') visit(t.source.contentHash);
  };
  for (const doc of roots(record))
    for (const p of doc.props ?? [])
      if (p.source.kind === 'bim') visitBim(p.source.contentHash);
      else visit(p.source.contentHash);
  return { reached, reachedBim, missing };
}

/** The record a character's native file carries: only the versions its props reach. */
export function portableCharacterRecord(record: StoredArtifact): StoredArtifact {
  if (record.kind !== 'character' || (!record.cadParts && !record.bimParts)) return record;
  const { reached, reachedBim } = characterPartClosure(record);
  return {
    ...record,
    ...(record.cadParts
      ? { cadParts: record.cadParts.filter((p) => reached.has(p.contentHash)) }
      : {}),
    ...(record.bimParts
      ? { bimParts: record.bimParts.filter((p) => reachedBim.has(p.contentHash)) }
      : {}),
  };
}

/**
 * Native import check: each kept version is valid CAD content under its own hash, once, and the
 * closure is exact (every placed version is kept, nothing else is).
 */
export function validateCharacterParts(record: StoredArtifact) {
  const parts: CadPartRecord[] = record.cadParts ?? [];
  if (!Array.isArray(parts)) throw new Error('Character props');
  const seen = new Set<string>();
  for (const p of parts) {
    if (
      !p ||
      typeof p !== 'object' ||
      Object.keys(p).sort().join() !== 'content,contentHash' ||
      typeof p.contentHash !== 'string'
    )
      throw new Error('Character prop');
    if (seen.has(p.contentHash)) throw new Error('Character prop duplicated');
    seen.add(p.contentHash);
    if (!isCadDocument(p.content)) throw new Error('Character prop content');
    if (cadContentHash(p.content) !== p.contentHash)
      throw new Error('Character prop hash mismatch');
  }
  const bimParts: BimPartRecord[] = record.bimParts ?? [];
  if (!Array.isArray(bimParts)) throw new Error('Character props');
  const seenBim = new Set<string>();
  for (const p of bimParts) {
    if (
      !p ||
      typeof p !== 'object' ||
      Object.keys(p).sort().join() !== 'content,contentHash' ||
      typeof p.contentHash !== 'string'
    )
      throw new Error('Character prop');
    if (seenBim.has(p.contentHash)) throw new Error('Character prop duplicated');
    seenBim.add(p.contentHash);
    if (!isBimDocument(p.content)) throw new Error('Character prop content');
    if (bimContentHash(p.content) !== p.contentHash)
      throw new Error('Character prop hash mismatch');
  }
  const { reached, reachedBim, missing } = characterPartClosure(record);
  if (missing.size) throw new Error('Character prop missing');
  if (reached.size !== seen.size || reachedBim.size !== seenBim.size)
    throw new Error('Character prop not referenced');
}

/**
 * Saved versions of the Playground's CAD Artifacts (C2b-3) and buildings (BIM, C8p), newest
 * first, as props to choose from.
 */
export function characterPropChoices(records: StoredArtifact[]): CharacterPropChoice[] {
  return records
    .filter((r) => (r.kind === 'cad' || r.kind === 'bim') && r.versions.length)
    .flatMap((r) =>
      [...r.versions].reverse().map((v, i, all) => ({
        kind: r.kind as 'cad' | 'bim',
        artifactId: r.id,
        versionId: v.versionId,
        contentHash: v.contentHash,
        label: `${r.name} — v${all.length - i}${v.reason ? ` (${v.reason})` : ''}`,
      })),
    );
}

/**
 * Keeps a chosen version, and the versions it places, in the character's record before an edit
 * names it: a CAD version and its parts in `cadParts`; a building in `bimParts` and the CAD
 * versions its part types place in `cadParts`. Imported shapes (STEP) and textures need bytes a
 * character does not keep: refused.
 */
export async function retainCharacterProp(options: {
  choice: CharacterPropChoice;
  records: StoredArtifact[];
  record: StoredArtifact | undefined;
  /** The character's content with the prop added: the native file is measured with it. */
  draft: CharacterDocument;
  persist(record: StoredArtifact): Promise<boolean>;
}): Promise<CadDocument | BimDocument> {
  const { choice, record } = options;
  const kind = choice.kind ?? 'cad';
  const source = options.records.find((r) => r.id === choice.artifactId && r.kind === kind);
  const version = source?.versions.find((v) => v.versionId === choice.versionId);
  if (!record || !source || !version || version.contentHash !== choice.contentHash)
    throw new Error('prop-source-missing');
  const closure = new Map<string, CadDocument>();
  const kept = new Map((source.cadParts ?? []).map((p) => [p.contentHash, p.content]));
  const visit = (hash: string) => {
    if (closure.has(hash)) return;
    const nested = kept.get(hash);
    if (!nested) throw new Error('prop-source-missing');
    closure.set(hash, nested);
    for (const part of nested.parts ?? []) visit(part.source.contentHash);
  };
  let content: CadDocument | BimDocument;
  const bimParts = [...(record.bimParts ?? [])];
  if (kind === 'bim') {
    const building = version.content as unknown as BimDocument;
    content = building;
    for (const t of building.types) if (t.kind === 'part') visit(t.source.contentHash);
    // A building's texture images (#662) live in its own record: not kept with a character.
    if (building.assets?.length) throw new Error('prop-assets-unsupported');
    if (!bimParts.some((p) => p.contentHash === choice.contentHash))
      bimParts.push({ contentHash: choice.contentHash, content: building });
  } else {
    const cad = version.content as unknown as CadDocument;
    content = cad;
    closure.set(choice.contentHash, cad);
    for (const part of cad.parts ?? []) visit(part.source.contentHash);
  }
  if ([...closure.values()].some((d) => d.assets.length))
    throw new Error('prop-assets-unsupported');
  const cadParts = [...(record.cadParts ?? [])];
  for (const [contentHash, doc] of closure)
    if (!cadParts.some((p) => p.contentHash === contentHash))
      cadParts.push({ contentHash, content: doc });
  const parts = { cadParts, ...(bimParts.length ? { bimParts } : {}) };
  // The native file must still fit once the prop is added: its draft names the new versions.
  const proposed = {
    ...record,
    draft: {
      ...record.draft,
      content: options.draft as unknown as StoredArtifact['draft']['content'],
    },
    ...parts,
  };
  // The stored record keeps versions Undo may need too, and is serialized whole on each save.
  if (
    nativeBytes(portableCadRecord(portableCharacterRecord(proposed))) > cadNativeFileBytes ||
    nativeBytes(proposed) > cadNativeFileBytes
  )
    throw new Error('prop-file-too-large');
  if (!(await options.persist({ ...record, ...parts }))) throw new Error('prop-retain-failed');
  return content;
}
