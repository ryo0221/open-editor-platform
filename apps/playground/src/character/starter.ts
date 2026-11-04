import { blockyFigure, type CharacterDocument } from '@editor-platform/character-core';

/** A kept asset, in the record's `cadResources` shape (see cad/resources.ts). */
interface StarterResource {
  kind: CharacterDocument['assets'][number]['kind'];
  sha256: string;
  byteLength: number;
  mediaType: string;
  encoding: 'base64';
  bytes: string;
}

const base64 = (bytes: Uint8Array) => {
  let raw = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(raw);
};

/**
 * A new character Artifact: the sample figure (F-C1) and its asset bytes. The fixture's refs
 * already carry each asset's SHA-256, so this stays synchronous like the other starters.
 */
export function characterStarter(): { doc: CharacterDocument; resources: StarterResource[] } {
  const { doc, assets } = blockyFigure();
  return {
    doc,
    resources: doc.assets.map((ref) => ({
      kind: ref.kind,
      sha256: ref.sha256,
      byteLength: ref.byteLength,
      mediaType: ref.mediaType,
      encoding: 'base64',
      bytes: base64(assets.get(ref.id)!),
    })),
  };
}
