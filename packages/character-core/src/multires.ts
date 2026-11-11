import {
  checkMultiresLevel,
  encodeMultiresChunk,
  epmSha256,
  multiresBase,
  multiresChunkCorners,
  multiresChunks,
  multiresGridSize,
  multiresJoin,
  multiresRaise,
  multiresTopology,
  type EpmMesh,
  type MultiresChunk,
} from '@editor-platform/geometry-mesh';
import { characterAssetMediaTypes, type CharacterAssetRef, type CharacterDocument } from './model';
import { characterIds, freshCharacterId, type CharacterOperation } from './operations';

/** A multires edit: stage every `assets` entry's bytes with the Host, then run `op`. */
export interface CharacterMultiresEdit {
  op: Extract<CharacterOperation, { type: 'setPartMultires' }>;
  assets: { ref: CharacterAssetRef; bytes: Uint8Array }[];
}

const partOf = (doc: CharacterDocument, partId: string) => {
  const part = doc.parts.find((p) => p.id === partId);
  if (!part) throw new Error('missing-target');
  return part;
};

/**
 * C7a: the edit that sets a part's multires to `displacements` (every corner grid at `level`, in
 * corner order). Each chunk is an asset named after its bytes, so a chunk a stroke did not touch
 * keeps the asset it had. With `corners` (the corner grids that changed, as
 * `multiresDisplacementsFrom` collects them) on a part whose multires is at `level`, only the
 * chunks holding them are encoded and hashed again; the rest keep their refs untouched, and
 * `assets` lists just the rewritten chunks (C7f: a stroke costs what it touched).
 */
export function characterMultiresSet(
  doc: CharacterDocument,
  partId: string,
  mesh: EpmMesh,
  level: number,
  displacements: Float32Array,
  corners?: ReadonlySet<number>,
): CharacterMultiresEdit {
  const part = partOf(doc, partId);
  // The surface must exist within the limits before anything is written.
  multiresBase(mesh, level);
  const chunks = multiresChunks(displacements, mesh.faceIndices.length, level);
  const taken = characterIds(doc);
  const known = new Map(doc.assets.map((a) => [`${a.kind}:${a.sha256}`, a]));
  const byId = new Map(doc.assets.map((a) => [a.id, a]));
  const current = part.multires;
  const keep =
    corners &&
    current &&
    current.level === level &&
    current.topology === multiresTopology(mesh) &&
    current.chunks.length === chunks.length &&
    current.chunks.every((id) => byId.get(id)?.kind === 'mesh-mres');
  const per = multiresChunkCorners(level);
  const dirty = new Set<number>();
  if (keep) for (const c of corners) dirty.add(Math.floor(c / per));
  const refs: CharacterAssetRef[] = [];
  const assets: { ref: CharacterAssetRef; bytes: Uint8Array }[] = [];
  chunks.forEach((chunk, i) => {
    if (keep && !dirty.has(i)) {
      refs.push(structuredClone(byId.get(current.chunks[i])!));
      return;
    }
    const made = encode(chunk);
    refs.push(made.ref);
    assets.push(made);
  });
  return {
    op: {
      type: 'setPartMultires',
      id: partId,
      multires: { level, topology: multiresTopology(mesh) },
      assets: refs,
    },
    assets,
  };
  function encode(chunk: (typeof chunks)[number]) {
    const bytes = encodeMultiresChunk(chunk);
    const sha256 = epmSha256(bytes);
    const same = known.get(`mesh-mres:${sha256}`);
    if (same) return { ref: structuredClone(same), bytes };
    const id = freshCharacterId(doc, `${part.id}-mres-${sha256.slice(7, 19)}`, taken);
    taken.add(id);
    const ref: CharacterAssetRef = {
      id,
      kind: 'mesh-mres',
      sha256,
      byteLength: bytes.length,
      mediaType: characterAssetMediaTypes['mesh-mres'],
    };
    known.set(`mesh-mres:${sha256}`, ref);
    return { ref, bytes };
  }
}

/** C7a: a new multires of `level` with no displacement yet. Refused on a part that has one. */
export function characterMultiresAdd(
  doc: CharacterDocument,
  partId: string,
  mesh: EpmMesh,
  level: number,
): CharacterMultiresEdit {
  if (partOf(doc, partId).multires) throw new Error('character-multires-exists');
  // Within the limits before the displacements are allocated.
  checkMultiresLevel(mesh, level);
  const G = multiresGridSize(level);
  return characterMultiresSet(
    doc,
    partId,
    mesh,
    level,
    new Float32Array(3 * mesh.faceIndices.length * G * G),
  );
}

/** C7a: one level more, the new grid points between the old ones (`multiresRaise`). */
export function characterMultiresRaise(
  doc: CharacterDocument,
  partId: string,
  mesh: EpmMesh,
  chunks: ReadonlyMap<string, MultiresChunk>,
): CharacterMultiresEdit {
  const part = partOf(doc, partId);
  if (!part.multires) throw new Error('character-multires-missing');
  const level = part.multires.level;
  checkMultiresLevel(mesh, level + 1);
  const d = characterMultiresDisplacements(part.multires, mesh, chunks);
  return characterMultiresSet(
    doc,
    partId,
    mesh,
    level + 1,
    multiresRaise(d, mesh.faceIndices.length, level),
  );
}

/** C7a: removes a part's multires (Undo brings its chunks back). */
export function characterMultiresRemove(
  doc: CharacterDocument,
  partId: string,
): Extract<CharacterOperation, { type: 'setPartMultires' }> {
  if (!partOf(doc, partId).multires) throw new Error('character-multires-missing');
  return { type: 'setPartMultires', id: partId, multires: null, assets: [] };
}

/** Every corner grid's displacements of a part's multires, from its decoded chunks. */
export function characterMultiresDisplacements(
  multires: NonNullable<CharacterDocument['parts'][number]['multires']>,
  mesh: EpmMesh,
  chunks: ReadonlyMap<string, MultiresChunk>,
): Float32Array {
  if (multiresTopology(mesh) !== multires.topology) throw new Error('character-multires-topology');
  const list = multires.chunks.map((id) => {
    const c = chunks.get(id);
    if (!c) throw new Error('character-multires-missing');
    return c;
  });
  return multiresJoin(list, mesh.faceIndices.length, multires.level);
}
