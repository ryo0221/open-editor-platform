import {
  boxMesh,
  encodeEpm,
  epmSha256,
  multiresTopology,
  type EpmMesh,
  type WeightBone,
} from '@editor-platform/geometry-mesh';
import { identityMat4, invertMat4, transformPoint } from './math';
import { restMatrices, skinMatrices, skinnedPositions } from './evaluate';
import {
  characterAssetMediaTypes,
  characterLimits,
  type CharacterAssetRef,
  type CharacterDocument,
  type CharacterSkin,
} from './model';
import type { GeometryTextureRole } from '@editor-platform/geometry-core';
import { gltfImportLimits } from './gltf';
import { characterIds, freshCharacterId, type CharacterOperation } from './operations';

/**
 * A mesh as a new asset of a document: its bytes and a ref whose ID carries the bytes' digest
 * (unused in the document).
 */
export function characterMeshAsset(
  doc: CharacterDocument,
  mesh: EpmMesh,
  base = 'mesh',
  taken = characterIds(doc),
): { ref: CharacterAssetRef; bytes: Uint8Array } {
  const bytes = encodeEpm(mesh);
  const sha256 = epmSha256(bytes);
  return {
    bytes,
    ref: {
      // Named after the bytes, so an ID never comes back for other bytes while Undo, Redo or the
      // Host's store may still hold the earlier ones under it.
      id: freshCharacterId(doc, `${base}-${sha256.slice(7, 19)}`, taken),
      kind: 'mesh-epm',
      sha256,
      byteLength: bytes.length,
      mediaType: characterAssetMediaTypes['mesh-epm'],
    },
  };
}

/** PNG or JPEG by the file's signature (not its name or stated type); undefined otherwise. */
export function characterImageKind(bytes: Uint8Array): 'texture-png' | 'texture-jpeg' | undefined {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return 'texture-png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'texture-jpeg';
  return undefined;
}

/**
 * The edit that sets a material's map to an image (C4): stage `bytes` with the Host first, then
 * run `op`. Throws `character-image-format` for bytes that are not PNG or JPEG, and
 * `character-image-size` past the import limit for one image (16 MiB).
 */
export function characterMaterialImage(
  doc: CharacterDocument,
  materialId: string,
  role: GeometryTextureRole,
  bytes: Uint8Array,
): {
  op: Extract<CharacterOperation, { type: 'setMaterialMap' }>;
  ref: CharacterAssetRef;
  bytes: Uint8Array;
} {
  const kind = characterImageKind(bytes);
  if (!kind) throw new Error('character-image-format');
  if (bytes.length > gltfImportLimits.imageBytes) throw new Error('character-image-size');
  const sha256 = epmSha256(bytes);
  const ref: CharacterAssetRef = {
    id: freshCharacterId(doc, `${materialId}-${role}-${sha256.slice(7, 19)}`, characterIds(doc)),
    kind,
    sha256,
    byteLength: bytes.length,
    mediaType: characterAssetMediaTypes[kind],
  };
  return { op: { type: 'setMaterialMap', id: materialId, role, asset: ref }, ref, bytes };
}

/** C7d: the part's materials that another part uses too (a map baked for it would land there). */
export function characterSharedMaterials(doc: CharacterDocument, partId: string): string[] {
  const part = doc.parts.find((p) => p.id === partId);
  if (!part) return [];
  return [...new Set(part.materials)].filter((id) =>
    doc.parts.some((p) => p.id !== partId && p.materials.includes(id)),
  );
}

/**
 * C7d: the edit that puts a baked normal map (PNG bytes; stage them with the Host first, then run
 * `op`) on every material of a part. Materials other parts share are copied for this part when
 * `copyShared`; otherwise throws `character-material-shared`. Throws `character-image-format`
 * for bytes that are not a PNG and `character-image-size` past the image limit.
 */
export function characterNormalBake(
  doc: CharacterDocument,
  partId: string,
  bytes: Uint8Array,
  copyShared: boolean,
): {
  op: Extract<CharacterOperation, { type: 'setPartNormalMap' }>;
  ref: CharacterAssetRef;
  bytes: Uint8Array;
} {
  const part = doc.parts.find((p) => p.id === partId);
  if (!part) throw new Error('character-missing-part');
  if (characterImageKind(bytes) !== 'texture-png') throw new Error('character-image-format');
  if (bytes.length > gltfImportLimits.imageBytes) throw new Error('character-image-size');
  const shared = characterSharedMaterials(doc, partId);
  if (shared.length && !copyShared) throw new Error('character-material-shared');
  const taken = characterIds(doc);
  const copies = shared.map((from) => {
    const m = doc.materials.find((x) => x.id === from)!;
    const id = freshCharacterId(doc, `${from}-${part.id}`, taken);
    taken.add(id);
    return { from, id, name: `${m.name} (${part.name})` };
  });
  const sha256 = epmSha256(bytes);
  const ref: CharacterAssetRef = {
    id: freshCharacterId(doc, `${part.id}-normal-${sha256.slice(7, 19)}`, taken),
    kind: 'texture-png',
    sha256,
    byteLength: bytes.length,
    mediaType: characterAssetMediaTypes['texture-png'],
  };
  return { op: { type: 'setPartNormalMap', id: partId, asset: ref, copies }, ref, bytes };
}

/**
 * The edit that swaps a part's mesh for an edited one (C3): stage `bytes` with the Host first,
 * then run `op`. The part keeps its ID, materials, skin and morphs. On a part with a multires,
 * an edit that changes the faces throws `character-multires-topology`.
 */
export function characterMeshEdit(
  doc: CharacterDocument,
  partId: string,
  mesh: EpmMesh,
): {
  op: Extract<CharacterOperation, { type: 'setPartMesh' }>;
  ref: CharacterAssetRef;
  bytes: Uint8Array;
} {
  // C7a: a sculpted part keeps its faces; moving its vertices is fine (the detail follows).
  const multires = doc.parts.find((p) => p.id === partId)?.multires;
  if (multires && multiresTopology(mesh) !== multires.topology)
    throw new Error('character-multires-topology');
  const { ref, bytes } = characterMeshAsset(doc, mesh, `${partId}-mesh`);
  return { op: { type: 'setPartMesh', id: partId, asset: ref }, ref, bytes };
}

/**
 * A new cube part to model from (C3, CH30): a box of `sizeMm` at the origin with one material
 * slot, using the document's first material or a new grey one. IDs are fresh and stay the
 * part's through every edit, save and reload.
 */
export function characterCubePart(
  doc: CharacterDocument,
  sizeMm = 200,
  name = 'Cube',
): {
  op: Extract<CharacterOperation, { type: 'addPart' }>;
  ref: CharacterAssetRef;
  bytes: Uint8Array;
} {
  const taken = characterIds(doc);
  const partId = freshCharacterId(doc, 'cube', taken);
  taken.add(partId);
  const { ref, bytes } = characterMeshAsset(
    doc,
    boxMesh([sizeMm, sizeMm, sizeMm]),
    `${partId}-mesh`,
    taken,
  );
  taken.add(ref.id);
  const existing = doc.materials[0];
  const material = existing
    ? undefined
    : {
        id: freshCharacterId(doc, 'material', taken),
        name: 'Material',
        color: '#b0b0b0',
        opacity: 1,
        roughness: 0.6,
        metalness: 0,
        maps: {},
        doubleSided: false,
      };
  return {
    op: {
      type: 'addPart',
      part: {
        id: partId,
        name,
        parentId: null,
        transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        mesh: ref.id,
        materials: [existing?.id ?? material!.id],
        visible: true,
      },
      asset: ref,
      ...(material ? { material } : {}),
    },
    ref,
    bytes,
  };
}

/**
 * How many of the oldest Undo entries to forget so the distinct asset bytes the history names
 * (with the current content and the Redo entries, which are always kept) stay within `cap`.
 * Assets are counted once per kind and SHA-256, by the length their refs give.
 */
export function characterHistoryOverflow(
  undo: readonly CharacterDocument[],
  kept: readonly CharacterDocument[],
  cap: number = characterLimits.historyAssetBytes,
): number {
  const seen = new Set<string>();
  let total = 0;
  const count = (doc: CharacterDocument) => {
    for (const a of doc.assets) {
      const key = `${a.kind}:${a.sha256}`;
      if (seen.has(key)) continue;
      seen.add(key);
      total += a.byteLength;
    }
  };
  for (const doc of kept) count(doc);
  for (let i = undo.length - 1; i >= 0; i--) {
    count(undo[i]);
    if (total > cap) return i + 1;
  }
  return 0;
}

/**
 * C5b: a part's mesh in character space at rest (its world transform applied to positions and
 * morph deltas): a skinned part's vertices live there, as in glTF, and its own transform no
 * longer moves it. `inverse` takes a bound mesh back to the part's own space (to unbind).
 */
export function characterBindMesh(
  doc: CharacterDocument,
  partId: string,
  mesh: EpmMesh,
  inverse = false,
): EpmMesh {
  const world = restMatrices(doc).parts.get(partId);
  if (!world) throw new Error('missing-target');
  const m = inverse ? invertMat4(world) : world;
  if (!m) throw new Error('character-part-degenerate');
  if (m.every((x, i) => x === identityMat4()[i])) return mesh;
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const q = transformPoint(m, [
      mesh.positions[i]!,
      mesh.positions[i + 1]!,
      mesh.positions[i + 2]!,
    ]);
    positions.set(q, i);
  }
  const linear = (d: Float32Array) => {
    const out = new Float32Array(d.length);
    for (let i = 0; i < d.length; i += 3)
      for (let r = 0; r < 3; r++)
        out[i + r] = m[r]! * d[i]! + m[4 + r]! * d[i + 1]! + m[8 + r]! * d[i + 2]!;
    return out;
  };
  const out: EpmMesh = {
    ...mesh,
    positions,
    morphs: mesh.morphs.map((x) => ({ id: x.id, deltas: linear(x.deltas) })),
  };
  // A reflection turns the faces inside out: their corners (and UVs) go the other way round.
  const det =
    m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) -
    m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) +
    m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);
  return det < 0 ? reverseWinding(out) : out;
}

/** Each face (or those `only` marks) with its corners in the other order (the first stays first). */
function reverseWinding(mesh: EpmMesh, only?: Uint8Array): EpmMesh {
  const faceIndices = new Uint32Array(mesh.faceIndices.length);
  const uvs = mesh.uvs ? new Float32Array(mesh.uvs.length) : undefined;
  let at = 0;
  for (let f = 0; f < mesh.faceSizes.length; f++) {
    const n = mesh.faceSizes[f]!;
    const turn = !only || only[f];
    for (let k = 0; k < n; k++) {
      const from = at + (!turn || k === 0 ? k : n - k);
      faceIndices[at + k] = mesh.faceIndices[from]!;
      if (uvs) {
        uvs[2 * (at + k)] = mesh.uvs![2 * from]!;
        uvs[2 * (at + k) + 1] = mesh.uvs![2 * from + 1]!;
      }
    }
    at += n;
  }
  return { ...mesh, faceIndices, ...(uvs ? { uvs } : {}) };
}

/**
 * A skinned mesh where its skin puts it at rest (character space): positions by linear blend
 * skinning with the rest skin matrices, morph deltas by each vertex's blended linear part. A skin
 * made by `characterSkinBind` is the identity at rest; an imported one need not be.
 */
function restSkinned(doc: CharacterDocument, skin: CharacterSkin, mesh: EpmMesh): EpmMesh {
  const joints = skinMatrices(skin, mesh, restMatrices(doc).bones);
  const w = mesh.weights;
  const id = identityMat4();
  if (!w || joints.every((j) => j.every((x, i) => Math.abs(x - id[i]!) < 1e-9))) return mesh;
  const deltas = mesh.morphs.map((x) => new Float32Array(x.deltas.length));
  const det = new Float64Array(mesh.positions.length / 3);
  for (let v = 0; v < mesh.positions.length / 3; v++) {
    const blend = new Array<number>(9).fill(0);
    if (w.offsets[v] === w.offsets[v + 1]) [0, 4, 8].forEach((i) => (blend[i] = 1));
    for (let k = w.offsets[v]!; k < w.offsets[v + 1]!; k++) {
      const j = joints[w.bones[k]!]!;
      for (let c = 0; c < 3; c++)
        for (let r = 0; r < 3; r++) blend[3 * c + r]! += w.values[k]! * j[4 * c + r]!;
    }
    det[v] =
      blend[0]! * (blend[4]! * blend[8]! - blend[7]! * blend[5]!) -
      blend[3]! * (blend[1]! * blend[8]! - blend[7]! * blend[2]!) +
      blend[6]! * (blend[1]! * blend[5]! - blend[4]! * blend[2]!);
    mesh.morphs.forEach((x, t) => {
      const d = x.deltas;
      for (let r = 0; r < 3; r++)
        deltas[t]![3 * v + r] =
          blend[r]! * d[3 * v]! + blend[3 + r]! * d[3 * v + 1]! + blend[6 + r]! * d[3 * v + 2]!;
    });
  }
  const out: EpmMesh = {
    ...mesh,
    positions: skinnedPositions(mesh, joints),
    morphs: mesh.morphs.map((x, t) => ({ id: x.id, deltas: deltas[t]! })),
  };
  // Faces the rest skin reflects turn around.
  const flip = new Uint8Array(mesh.faceSizes.length);
  let at = 0;
  mesh.faceSizes.forEach((n, f) => {
    // The view's rule: a face turns when most of its corners are reflected (by sign, not size).
    let reflected = 0;
    for (let k = 0; k < n; k++) if (det[mesh.faceIndices[at + k]!]! < 0) reflected++;
    flip[f] = 2 * reflected > n ? 1 : 0;
    at += n;
  });
  return flip.some(Boolean) ? reverseWinding(out, flip) : out;
}

/**
 * C5b: the bones of a skeleton as segments in character space at rest (where a bound mesh's
 * vertices are, see `characterBindMesh`), for automatic weights: from each bone's head to the mean of its children's heads (a leaf continues half
 * its parent's length; a lone root is a point).
 */
export function characterWeightBones(
  doc: CharacterDocument,
  partId: string,
  skeletonId: string,
): { bones: WeightBone[]; boneIds: string[] } {
  const skeleton = doc.skeletons.find((s) => s.id === skeletonId);
  if (!skeleton || !doc.parts.some((p) => p.id === partId)) throw new Error('missing-target');
  const world = restMatrices(doc);
  const head = new Map(
    skeleton.bones.map((b) => {
      const m = world.bones.get(b.id)!;
      return [b.id, [m[12]!, m[13]!, m[14]!] as [number, number, number]];
    }),
  );
  const bones = skeleton.bones.map((b) => {
    const h = head.get(b.id)!;
    const kids = skeleton.bones.filter((c) => c.parentId === b.id).map((c) => head.get(c.id)!);
    let tail = h;
    if (kids.length)
      tail = [0, 1, 2].map((k) => kids.reduce((s, c) => s + c[k]!, 0) / kids.length) as typeof h;
    else if (b.parentId) {
      const ph = head.get(b.parentId)!;
      tail = [0, 1, 2].map((k) => h[k]! + 0.5 * (h[k]! - ph[k]!)) as typeof h;
    }
    return { head: [...h] as WeightBone['head'], tail: [...tail] as WeightBone['tail'] };
  });
  return { bones, boneIds: skeleton.bones.map((b) => b.id) };
}

/**
 * C5b: the edit that binds a part to a skeleton with `weighted` (its mesh in character space,
 * from `characterBindMesh`, with weights over the skeleton's bones): bones no vertex weights are
 * left out, and each kept bone's inverse bind is inverse(bone at rest), so the mesh stays where
 * it is. Stage `bytes` first.
 */
export function characterSkinBind(
  doc: CharacterDocument,
  partId: string,
  skeletonId: string,
  weighted: EpmMesh,
): {
  op: Extract<CharacterOperation, { type: 'bindSkin' }>;
  ref: CharacterAssetRef;
  bytes: Uint8Array;
} {
  const w = weighted.weights;
  if (!w) throw new Error('character-skin-without-weights');
  // Only the bones some vertex weights, renumbered in skeleton order.
  const used = [...new Set(w.bones)].sort((a, b) => a - b);
  const index = new Map(used.map((b, k) => [b, k]));
  const mesh: EpmMesh = {
    ...weighted,
    boneIds: used.map((b) => weighted.boneIds[b]!),
    weights: { ...w, bones: Uint16Array.from(w.bones, (b) => index.get(b)!) },
  };
  const world = restMatrices(doc);
  const inverseBind = mesh.boneIds.map((boneId) => {
    const inv = invertMat4(world.bones.get(boneId)!);
    if (!inv) throw new Error('character-bone-degenerate');
    return { boneId, matrix: inv };
  });
  const taken = characterIds(doc);
  const { ref, bytes } = characterMeshAsset(doc, mesh, `${partId}-mesh`, taken);
  taken.add(ref.id);
  const id = freshCharacterId(doc, `${partId}-skin`, taken);
  return {
    op: { type: 'bindSkin', skin: { id, partId, skeletonId, inverseBind }, asset: ref },
    ref,
    bytes,
  };
}

/**
 * C5b: the edit that unbinds a skin; the part keeps `mesh` (the bound one) without its weights,
 * back in the part's own space so it stays where it is at rest.
 */
export function characterSkinUnbind(
  doc: CharacterDocument,
  skinId: string,
  mesh: EpmMesh,
): {
  op: Extract<CharacterOperation, { type: 'unbindSkin' }>;
  ref: CharacterAssetRef;
  bytes: Uint8Array;
} {
  const skin = doc.skins.find((k) => k.id === skinId);
  if (!skin) throw new Error('missing-target');
  // Where the skin shows it at rest, then back into the part's own space.
  const rest = restSkinned(doc, skin, mesh);
  const plain: EpmMesh = { ...characterBindMesh(doc, skin.partId, rest, true), boneIds: [] };
  delete plain.weights;
  const { ref, bytes } = characterMeshAsset(doc, plain, `${skin.partId}-mesh`);
  return { op: { type: 'unbindSkin', id: skinId, asset: ref }, ref, bytes };
}

/**
 * C5c: the edit that gives a bound part `painted` (its mesh with new weights): bones it weights
 * keep their inverse bind, a newly weighted bone gets inverse(bone at rest) (the bound mesh is
 * in character space, see `characterBindMesh`), and
 * a bone it no longer weights leaves the skin. Stage `bytes` first.
 */
export function characterSkinWeights(
  doc: CharacterDocument,
  skinId: string,
  painted: EpmMesh,
): {
  op: Extract<CharacterOperation, { type: 'setSkinWeights' }>;
  ref: CharacterAssetRef;
  bytes: Uint8Array;
} {
  const skin = doc.skins.find((k) => k.id === skinId);
  if (!skin) throw new Error('missing-target');
  const skeleton = doc.skeletons.find((s) => s.id === skin.skeletonId)!;
  const owned = new Set(skeleton.bones.map((b) => b.id));
  if (painted.boneIds.some((b) => !owned.has(b))) throw new Error('character-skin-bone');
  const kept = new Map(skin.inverseBind.map((e) => [e.boneId, e.matrix]));
  const world = restMatrices(doc);
  const inverseBind = painted.boneIds.map((boneId) => {
    const was = kept.get(boneId);
    if (was) return { boneId, matrix: [...was] };
    const inv = invertMat4(world.bones.get(boneId)!);
    if (!inv) throw new Error('character-bone-degenerate');
    return { boneId, matrix: inv };
  });
  const { ref, bytes } = characterMeshAsset(doc, painted, `${skin.partId}-mesh`);
  return { op: { type: 'setSkinWeights', id: skinId, asset: ref, inverseBind }, ref, bytes };
}

/**
 * C6a: the edit that adds a morph named `name` to a part whose mesh is `mesh`: the mesh gains
 * the morph's deltas (all zero), last among its morphs, and the document gains the morph at
 * weight 0. Stage `bytes` first.
 */
export function characterMorphAdd(
  doc: CharacterDocument,
  partId: string,
  mesh: EpmMesh,
  name: string,
): {
  op: Extract<CharacterOperation, { type: 'addMorph' }>;
  ref: CharacterAssetRef;
  bytes: Uint8Array;
} {
  if (!doc.parts.some((p) => p.id === partId)) throw new Error('missing-target');
  const taken = characterIds(doc);
  const id = freshCharacterId(doc, `${partId}/morph`, taken);
  taken.add(id);
  const next: EpmMesh = {
    ...mesh,
    morphs: [...mesh.morphs, { id, deltas: new Float32Array(mesh.positions.length) }],
  };
  const { ref, bytes } = characterMeshAsset(doc, next, `${partId}-mesh`, taken);
  return {
    op: { type: 'addMorph', morph: { id, partId, name, weight: 0 }, asset: ref },
    ref,
    bytes,
  };
}

/** C6a: the edit that removes a morph: its part's mesh `mesh` loses its deltas. Stage `bytes` first. */
export function characterMorphRemove(
  doc: CharacterDocument,
  morphId: string,
  mesh: EpmMesh,
): {
  op: Extract<CharacterOperation, { type: 'removeMorph' }>;
  ref: CharacterAssetRef;
  bytes: Uint8Array;
} {
  const morph = doc.morphs.find((m) => m.id === morphId);
  if (!morph || !mesh.morphs.some((m) => m.id === morphId)) throw new Error('missing-target');
  const next: EpmMesh = { ...mesh, morphs: mesh.morphs.filter((m) => m.id !== morphId) };
  const { ref, bytes } = characterMeshAsset(doc, next, `${morph.partId}-mesh`);
  return { op: { type: 'removeMorph', id: morphId, asset: ref }, ref, bytes };
}

/** C6b: `mesh` as its morph `morphId` makes it at weight 1 (where its shape is edited). */
export function characterMorphedMesh(mesh: EpmMesh, morphId: string): EpmMesh {
  const morph = mesh.morphs.find((m) => m.id === morphId);
  if (!morph) throw new Error('missing-target');
  const positions = mesh.positions.slice();
  for (let i = 0; i < positions.length; i++) positions[i]! += morph.deltas[i]!;
  return { ...mesh, positions };
}

/**
 * C6b: the edit that gives a morph the shape `shaped` (the part's mesh `mesh` as the morph makes
 * it, its vertices moved): the morph's deltas become `shaped − mesh`, and nothing else of the
 * mesh changes. Refused (`character-morph-shape`) when `shaped` has another vertex count or a
 * value that is not finite. Stage `bytes` first.
 */
export function characterMorphShape(
  doc: CharacterDocument,
  partId: string,
  mesh: EpmMesh,
  morphId: string,
  shaped: Float32Array,
): {
  op: Extract<CharacterOperation, { type: 'setPartMesh' }>;
  ref: CharacterAssetRef;
  bytes: Uint8Array;
} {
  if (!doc.morphs.some((m) => m.id === morphId && m.partId === partId))
    throw new Error('missing-target');
  if (!mesh.morphs.some((m) => m.id === morphId)) throw new Error('missing-target');
  if (shaped.length !== mesh.positions.length || !shaped.every(Number.isFinite))
    throw new Error('character-morph-shape');
  const deltas = new Float32Array(shaped.length);
  for (let i = 0; i < deltas.length; i++) deltas[i] = shaped[i]! - mesh.positions[i]!;
  const next: EpmMesh = {
    ...mesh,
    morphs: mesh.morphs.map((m) => (m.id === morphId ? { id: m.id, deltas } : m)),
  };
  return characterMeshEdit(doc, partId, next);
}
