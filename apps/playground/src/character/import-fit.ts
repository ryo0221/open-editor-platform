import type { CharacterDocument } from '@editor-platform/character-core';
import type { StoredArtifact } from '../model';
import {
  cadNativeLimit,
  cadNativeLimitText,
  encodeBytes,
  nativeBytes,
  portableCadRecord,
  type CadResource,
} from '../cad/resources';

/**
 * Refuses an import whose record afterwards would no longer be a native file the Playground can
 * read back (the new content as the draft, the kept versions, every asset they name), or would
 * no longer be storable with the assets it keeps for Undo. Checked before anything is saved or
 * changed.
 */
export function assertCharacterImportFits(
  latest: StoredArtifact,
  doc: CharacterDocument,
  assets: ReadonlyMap<string, Uint8Array>,
) {
  const resources = [...(latest.cadResources ?? [])];
  for (const ref of doc.assets)
    if (
      assets.has(ref.id) &&
      !resources.some((r) => r.kind === ref.kind && r.sha256 === ref.sha256)
    )
      resources.push({
        kind: ref.kind as unknown as CadResource['kind'],
        sha256: ref.sha256,
        byteLength: ref.byteLength,
        mediaType: ref.mediaType,
        encoding: 'base64',
        bytes: encodeBytes(assets.get(ref.id)!),
      });
  const after = { ...latest, draft: { ...latest.draft, content: doc }, cadResources: resources };
  const size = nativeBytes(portableCadRecord(after));
  if (size > cadNativeLimit.bytes)
    throw new Error(
      `the native file would be ${(size / 1e6).toFixed(1)} MB, over the ${cadNativeLimitText()} limit`,
    );
  // The stored record also keeps assets only Undo still names (earlier imports): it must stay
  // storable too, or every later edit of this character would fail to save.
  const stored = nativeBytes(after);
  if (stored > cadNativeLimit.bytes)
    throw new Error(
      `the stored record would be ${(stored / 1e6).toFixed(1)} MB with the assets Undo keeps, over the ${cadNativeLimitText()} limit`,
    );
}

/**
 * Character Undo/Redo is admitted like an edit: the restored content (whose assets the record
 * already keeps) must leave the record exportable and storable with the versions saved since.
 */
export function assertCharacterHistoryFits(latest: StoredArtifact, content: CharacterDocument) {
  assertCharacterImportFits(latest, content, new Map());
}
