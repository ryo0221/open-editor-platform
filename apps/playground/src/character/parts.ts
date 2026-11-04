/**
 * The CAD versions a character keeps for its props (C2b-3), by content hash in its record's
 * `cadParts`: the closure its draft and versions reach, carried in its native file.
 */
import { cadContentHash, isCadDocument, type CadDocument } from '@editor-platform/cad-core';
import type { CharacterDocument } from '@editor-platform/character-core';
import type { StoredArtifact } from '../model';
import type { CharacterPropChoice } from '@editor-platform/character';
import type { CadPartRecord } from '../cad/parts';
import { cadNativeFileBytes, nativeBytes, portableCadRecord } from '../cad/resources';

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
  record: Pick<StoredArtifact, 'draft' | 'versions' | 'cadParts'>,
) {
  const kept = new Map((record.cadParts ?? []).map((p) => [p.contentHash, p.content]));
  const reached = new Map<string, CadDocument>();
  const missing = new Set<string>();
  const visit = (hash: string) => {
    if (reached.has(hash) || missing.has(hash)) return;
    const content = kept.get(hash);
    if (!content) return void missing.add(hash);
    reached.set(hash, content);
    for (const part of content.parts ?? []) visit(part.source.contentHash);
  };
  for (const doc of roots(record)) for (const p of doc.props ?? []) visit(p.source.contentHash);
  return { reached, missing };
}

/** The record a character's native file carries: only the versions its props reach. */
export function portableCharacterRecord(record: StoredArtifact): StoredArtifact {
  if (record.kind !== 'character' || !record.cadParts) return record;
  const { reached } = characterPartClosure(record);
  return { ...record, cadParts: record.cadParts.filter((p) => reached.has(p.contentHash)) };
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
  const { reached, missing } = characterPartClosure(record);
  if (missing.size) throw new Error('Character prop missing');
  if (reached.size !== seen.size) throw new Error('Character prop not referenced');
}

/** Saved versions of the Playground's CAD Artifacts, newest first, as props to choose from. */
export function characterPropChoices(records: StoredArtifact[]): CharacterPropChoice[] {
  return records
    .filter((r) => r.kind === 'cad' && r.versions.length)
    .flatMap((r) =>
      [...r.versions].reverse().map((v, i, all) => ({
        artifactId: r.id,
        versionId: v.versionId,
        contentHash: v.contentHash,
        label: `${r.name} — v${all.length - i}${v.reason ? ` (${v.reason})` : ''}`,
      })),
    );
}

/**
 * Keeps a chosen version, and the versions it places, in the character's record before an edit
 * names it. Imported shapes (STEP) and textures need bytes a character does not keep: refused.
 */
export async function retainCharacterProp(options: {
  choice: CharacterPropChoice;
  records: StoredArtifact[];
  record: StoredArtifact | undefined;
  /** The character's content with the prop added: the native file is measured with it. */
  draft: CharacterDocument;
  persist(record: StoredArtifact): Promise<boolean>;
}): Promise<CadDocument> {
  const { choice, record } = options;
  const source = options.records.find((r) => r.id === choice.artifactId && r.kind === 'cad');
  const version = source?.versions.find((v) => v.versionId === choice.versionId);
  if (!record || !source || !version || version.contentHash !== choice.contentHash)
    throw new Error('prop-source-missing');
  const content = version.content as unknown as CadDocument;
  const closure = new Map<string, CadDocument>([[choice.contentHash, content]]);
  const kept = new Map((source.cadParts ?? []).map((p) => [p.contentHash, p.content]));
  const visit = (doc: CadDocument) => {
    for (const part of doc.parts ?? []) {
      const hash = part.source.contentHash;
      if (closure.has(hash)) continue;
      const nested = kept.get(hash);
      if (!nested) throw new Error('prop-source-missing');
      closure.set(hash, nested);
      visit(nested);
    }
  };
  visit(content);
  if ([...closure.values()].some((d) => d.assets.length))
    throw new Error('prop-assets-unsupported');
  const cadParts = [...(record.cadParts ?? [])];
  for (const [contentHash, doc] of closure)
    if (!cadParts.some((p) => p.contentHash === contentHash))
      cadParts.push({ contentHash, content: doc });
  // The native file must still fit once the prop is added: its draft names the new versions.
  const proposed = {
    ...record,
    draft: {
      ...record.draft,
      content: options.draft as unknown as StoredArtifact['draft']['content'],
    },
    cadParts,
  };
  // The stored record keeps versions Undo may need too, and is serialized whole on each save.
  if (
    nativeBytes(portableCadRecord(portableCharacterRecord(proposed))) > cadNativeFileBytes ||
    nativeBytes(proposed) > cadNativeFileBytes
  )
    throw new Error('prop-file-too-large');
  if (!(await options.persist({ ...record, cadParts }))) throw new Error('prop-retain-failed');
  return content;
}
