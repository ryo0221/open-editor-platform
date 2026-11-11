import { checkCharacterMeshes, type CharacterDocument } from '@editor-platform/character-core';
import {
  decodeEpm,
  decodeMultiresChunk,
  epmSha256,
  MeshAssetError,
  MultiresAssetError,
  type EpmMesh,
  type MultiresChunk,
} from '@editor-platform/geometry-mesh';

export interface CharacterAssetRead {
  meshes: Map<string, EpmMesh>;
  /** C7a: decoded multires chunks by asset ID. */
  multires: Map<string, MultiresChunk>;
  /** Image bytes the document names, checked against their SHA-256. */
  images: Map<string, { bytes: Uint8Array; mediaType: string }>;
  /** Why the document cannot be shown, one line each; empty when it can. */
  problems: string[];
}

/**
 * Reads the Host's asset bytes for a document: every asset must be there, have the length and
 * SHA-256 the content names, and every mesh must decode and match the document. Nothing is
 * repaired; a problem keeps the view empty.
 */
export function readCharacterAssets(
  doc: CharacterDocument,
  bytes: ReadonlyMap<string, Uint8Array>,
): CharacterAssetRead {
  return checkCharacterAssets(doc, decodeCharacterAssets(doc.assets, bytes));
}

/**
 * The byte half of `readCharacterAssets`: depends only on the asset records and bytes, so a
 * Surface can keep it across edits that leave the assets alone.
 */
export function decodeCharacterAssets(
  refs: CharacterDocument['assets'],
  bytes: ReadonlyMap<string, Uint8Array>,
): CharacterAssetRead {
  const meshes = new Map<string, EpmMesh>();
  const multires = new Map<string, MultiresChunk>();
  const images = new Map<string, { bytes: Uint8Array; mediaType: string }>();
  const problems: string[] = [];
  for (const ref of refs) {
    const b = bytes.get(ref.id);
    if (!b) {
      problems.push(`${ref.id}: missing`);
      continue;
    }
    if (b.length !== ref.byteLength || epmSha256(b) !== ref.sha256) {
      problems.push(`${ref.id}: bytes do not match the document`);
      continue;
    }
    if (ref.kind === 'mesh-mres') {
      try {
        multires.set(ref.id, decodeMultiresChunk(b));
      } catch (e) {
        if (!(e instanceof MultiresAssetError)) throw e;
        problems.push(`${ref.id}: ${e.problem} ${e.detail}`);
      }
      continue;
    }
    if (ref.kind !== 'mesh-epm') {
      images.set(ref.id, { bytes: b, mediaType: ref.mediaType });
      continue;
    }
    try {
      meshes.set(ref.id, decodeEpm(b));
    } catch (e) {
      if (!(e instanceof MeshAssetError)) throw e;
      problems.push(`${ref.id}: ${e.problem} ${e.detail}`);
    }
  }
  return { meshes, multires, images, problems };
}

/**
 * The document half: whether the decoded meshes fit the current parts, skins and morphs. Cheap,
 * and run for every document, since a new document can reuse the same assets.
 */
export function checkCharacterAssets(
  doc: CharacterDocument,
  decoded: CharacterAssetRead,
): CharacterAssetRead {
  if (decoded.problems.length) return decoded;
  const problems = checkCharacterMeshes(doc, decoded.meshes, decoded.multires).map(
    (d) => `${d.path}: ${d.code}`,
  );
  return problems.length ? { ...decoded, problems } : decoded;
}
