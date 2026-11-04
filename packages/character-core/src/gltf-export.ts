import {
  cornerNormals,
  fourInfluences,
  triangulateFace,
  type EpmMesh,
} from '@editor-platform/geometry-mesh';
import { poseAt, restMatrices, solvedBones } from './evaluate';
import { ikChainBones } from './ik';
import { invertMat4, multiplyMat4, multiplyQuat, normalizeQuat, type Mat4 } from './math';
import { characterLimits } from './model';
import type {
  CharacterAction,
  CharacterDocument,
  CharacterKey,
  CharacterMaterial,
  Quat,
  Vec3,
} from './model';
import { checkCharacterMeshes, validateCharacter } from './validation';

/**
 * C6c (#685): writes a character document as glTF 2.0 binary (GLB), the inverse of `importGltf`.
 * Units go from mm Z-up to metres Y-up. Meshes are triangulated (one primitive per material
 * slot), skins keep the four largest weights per vertex, morphs become position targets, and
 * actions become animations (bone and part TRS, morph weights). IK is baked: the solved rotations
 * of every enabled chain's bones are sampled per frame. IDs go to `extras.ep_id` (morphs: the
 * mesh's `extras.ep_morph_ids`) so a re-import keeps them. What glTF cannot hold is listed in
 * `losses` as stable codes with a count, as the importer does.
 */
export interface GltfExport {
  bytes: Uint8Array;
  losses: string[];
}
export type GltfExportProblem = 'document' | 'missing-asset' | 'limit';
export class GltfExportError extends Error {
  constructor(
    readonly problem: GltfExportProblem,
    readonly detail: string,
  ) {
    super(`gltf-export: ${problem}: ${detail}`);
    this.name = 'GltfExportError';
  }
}
const fail = (problem: GltfExportProblem, detail: string): never => {
  throw new GltfExportError(problem, detail);
};

export const gltfExportLimits = Object.freeze({
  /** What `importGltf` reads back (its `fileBytes` and `nodes`). */
  fileBytes: 256 * 1024 * 1024,
  nodes: 4096,
});

/** mm, Z-up → glTF (m, Y-up): (x, y, z) → (x, z, −y) / 1000. */
const pointOut = (p: ArrayLike<number>, at = 0): Vec3 => [
  p[at] / 1000,
  p[at + 2] / 1000,
  -p[at + 1] / 1000,
];
const vecOut = (p: ArrayLike<number>, at = 0): Vec3 => [p[at], p[at + 2], -p[at + 1]];
const qC: Quat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const qCinv: Quat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const rotationOut = (q: Quat): Quat => normalizeQuat(multiplyQuat(multiplyQuat(qCinv, q), qC));
const scaleOut = (s: Vec3): Vec3 => [s[0], s[2], s[1]];
const A: Mat4 = [1000, 0, 0, 0, 0, 0, 1000, 0, 0, -1000, 0, 0, 0, 0, 0, 1];
const Ainv: Mat4 = invertMat4(A)!;
const matrixOut = (m: Mat4): Mat4 => multiplyMat4(multiplyMat4(Ainv, m), A);

/** `#rrggbb` sRGB → glTF's linear factor (the inverse of the importer's `srgbHex`). */
function linearColor(hex: string): [number, number, number] {
  const c = (k: number) => {
    const v = parseInt(hex.slice(1 + 2 * k, 3 + 2 * k), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return [c(0), c(1), c(2)];
}

type J = Record<string, unknown>;
const FLOAT = 5126,
  UNSIGNED_SHORT = 5123,
  UNSIGNED_INT = 5125,
  ARRAY_BUFFER = 34962,
  ELEMENT_ARRAY_BUFFER = 34963;
const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 } as const;

class Writer {
  chunks: Uint8Array[] = [];
  length = 0;
  bufferViews: J[] = [];
  accessors: J[] = [];
  losses = new Map<string, number>();
  loss(code: string, n = 1) {
    if (n > 0) this.losses.set(code, (this.losses.get(code) ?? 0) + n);
  }
  view(data: ArrayBufferView, target?: number): number {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (this.length + bytes.length > gltfExportLimits.fileBytes) fail('limit', 'file bytes');
    this.bufferViews.push({
      buffer: 0,
      byteOffset: this.length,
      byteLength: bytes.byteLength,
      ...(target ? { target } : {}),
    });
    this.chunks.push(bytes);
    this.length += bytes.byteLength;
    // An image may end anywhere: the next view starts on a multiple of 4 bytes.
    const gap = (4 - (this.length % 4)) % 4;
    if (gap) {
      this.chunks.push(new Uint8Array(gap));
      this.length += gap;
    }
    return this.bufferViews.length - 1;
  }
  /** An accessor of tightly packed elements; float ones carry min and max (POSITION needs it). */
  accessor(
    data: Float32Array | Uint16Array | Uint32Array,
    type: keyof typeof components,
    target?: number,
  ): number {
    const n = components[type];
    const count = data.length / n;
    const componentType =
      data instanceof Float32Array
        ? FLOAT
        : data instanceof Uint16Array
          ? UNSIGNED_SHORT
          : UNSIGNED_INT;
    const a: J = { bufferView: this.view(data, target), componentType, count, type };
    if (data instanceof Float32Array && type !== 'MAT4' && count > 0) {
      const min = Array(n).fill(Infinity),
        max = Array(n).fill(-Infinity);
      for (let i = 0; i < data.length; i++) {
        const k = i % n;
        if (data[i] < min[k]) min[k] = data[i];
        if (data[i] > max[k]) max[k] = data[i];
      }
      a.min = min;
      a.max = max;
    }
    return this.accessors.push(a) - 1;
  }
}

/**
 * The document as GLB. `meshes` holds every part's mesh asset by asset ID, `images` every
 * texture image's bytes by asset ID. Refuses (`GltfExportError`) a document that does not
 * validate or has no part, an asset it does not have, and output past `gltfExportLimits`.
 */
export function exportGlb(
  doc: CharacterDocument,
  meshes: ReadonlyMap<string, EpmMesh>,
  images: ReadonlyMap<string, Uint8Array>,
): GltfExport {
  for (const p of doc.parts) if (!meshes.has(p.mesh)) fail('missing-asset', p.mesh);
  const diagnostics = [...validateCharacter(doc), ...checkCharacterMeshes(doc, meshes)];
  if (diagnostics.length)
    fail(
      'document',
      diagnostics
        .slice(0, 5)
        .map((d) => `${d.code} ${d.path}`)
        .join('; '),
    );
  if (!doc.parts.length) fail('document', 'no part to export');
  const bones = doc.skeletons.flatMap((s) => s.bones);
  if (doc.parts.length + bones.length > gltfExportLimits.nodes) fail('limit', 'nodes');

  const w = new Writer();
  // Nodes: every part, then every bone (parts first, so node indices are stable).
  const partNode = new Map(doc.parts.map((p, i) => [p.id, i]));
  const boneNode = new Map(bones.map((b, i) => [b.id, doc.parts.length + i]));
  const nodes: J[] = [];
  const children = new Map<number, number[]>();
  const sceneNodes: number[] = [];
  const hang = (parent: number | undefined, child: number) => {
    if (parent === undefined) sceneNodes.push(child);
    else children.set(parent, [...(children.get(parent) ?? []), child]);
  };
  const trs = (t: { translation: Vec3; rotation: Quat; scale: Vec3 }) => ({
    translation: pointOut(t.translation),
    rotation: rotationOut(t.rotation),
    scale: scaleOut(t.scale),
  });
  // A part of several material slots is a group of meshes in three.js, whose morph weights
  // reach every mesh child of the group: its child parts hang from an identity node instead
  // (the importer folds it), so they keep their own morphs.
  const holders: J[] = [];
  const holderOf = new Map<string, number>();
  const slotsOf = (partId: string) => {
    const mesh = meshes.get(doc.parts.find((p) => p.id === partId)!.mesh)!;
    return new Set(mesh.faceMaterials).size;
  };
  const partParent = (parentId: string | null) => {
    if (!parentId) return undefined;
    if (slotsOf(parentId) < 2) return partNode.get(parentId);
    let at = holderOf.get(parentId);
    if (at === undefined) {
      at = doc.parts.length + bones.length + holders.length;
      holders.push({ name: `${doc.parts.find((p) => p.id === parentId)!.name} parts` });
      holderOf.set(parentId, at);
      hang(partNode.get(parentId), at);
    }
    return at;
  };
  for (const p of doc.parts) {
    nodes.push({ name: p.name, ...trs(p.transform), extras: { ep_id: p.id } });
    hang(partParent(p.parentId), partNode.get(p.id)!);
    if (!p.visible) w.loss('hidden-part');
    if (p.subdivision && (p.subdivision.levels > 0 || p.subdivision.renderLevels > 0))
      w.loss('subdivision');
  }
  // The static pose is what the editor shows without an action: enabled IK chains solved (the
  // inverse binds stay the document's, so the bound shape does not move).
  const shown = doc.skeletons.some((s) => s.ik?.some((c) => c.enabled))
    ? solvedBones(doc, poseAt(doc, null, 0))
    : undefined;
  for (const s of doc.skeletons)
    for (const b of s.bones) {
      nodes.push({ name: b.name, ...trs(shown?.get(b.id) ?? b.rest), extras: { ep_id: b.id } });
      if (b.limits) w.loss('bone-limits');
    }
  if (nodes.length + holders.length > gltfExportLimits.nodes) fail('limit', 'nodes');
  nodes.push(...holders);
  for (const s of doc.skeletons) {
    const roots = s.bones.filter((b) => !b.parentId);
    // glTF wants a skin's joints under one common ancestor: several roots at the character's
    // origin hang from an identity node named after the skeleton.
    let base = s.parentPartId ? partNode.get(s.parentPartId) : undefined;
    if (base === undefined && roots.length > 1) {
      if (nodes.length >= gltfExportLimits.nodes) fail('limit', 'nodes');
      base = nodes.push({ name: s.name }) - 1;
      hang(undefined, base);
    }
    for (const b of s.bones)
      hang(b.parentId ? boneNode.get(b.parentId) : base, boneNode.get(b.id)!);
  }
  for (const [i, c] of children) nodes[i].children = c;

  // Materials and their texture images (glTF's metallic-roughness texture packs two channels in
  // one image: separate roughness and metalness maps are not repacked).
  const imageIndex = new Map<string, number>();
  const gltfImages: J[] = [];
  const textures: J[] = [];
  const textureOf = (assetId: string) => {
    let i = imageIndex.get(assetId);
    if (i === undefined) {
      const bytes = images.get(assetId) ?? fail('missing-asset', assetId);
      const ref = doc.assets.find((a) => a.id === assetId);
      gltfImages.push({ bufferView: w.view(bytes), mimeType: ref?.mediaType ?? 'image/png' });
      i = textures.push({ source: gltfImages.length - 1 }) - 1;
      imageIndex.set(assetId, i);
    }
    return { index: i };
  };
  const materialIndex = new Map(doc.materials.map((m, i) => [m.id, i]));
  const materials = doc.materials.map((m: CharacterMaterial) => {
    const pbr: J = {
      baseColorFactor: [...linearColor(m.color), m.opacity],
      metallicFactor: m.metalness,
      roughnessFactor: m.roughness,
    };
    if (m.maps.color) pbr.baseColorTexture = textureOf(m.maps.color);
    const out: J = { name: m.name, pbrMetallicRoughness: pbr, extras: { ep_id: m.id } };
    if (m.maps.normal) out.normalTexture = textureOf(m.maps.normal);
    if (m.maps.occlusion) out.occlusionTexture = textureOf(m.maps.occlusion);
    if (m.maps.roughness) w.loss('roughness-map');
    if (m.maps.metalness) w.loss('metalness-map');
    if (m.opacity < 1) out.alphaMode = 'BLEND';
    if (m.doubleSided) out.doubleSided = true;
    return out;
  });

  // Skins: one per document skin, its joints every bone of the skeleton (so skins of a
  // skeleton share joints and are read back as one skeleton).
  const rest = restMatrices(doc).bones;
  const skinIndex = new Map<string, number>();
  const skins = doc.skins.map((skin, i) => {
    const skeleton = doc.skeletons.find((s) => s.id === skin.skeletonId)!;
    const bound = new Map(skin.inverseBind.map((e) => [e.boneId, e.matrix]));
    const ibm = new Float32Array(16 * skeleton.bones.length);
    skeleton.bones.forEach((b, k) => {
      // A bone the weights do not name binds at its rest pose.
      const m = bound.get(b.id) ?? invertMat4(rest.get(b.id)!) ?? fail('document', b.id);
      ibm.set(matrixOut(m), 16 * k);
    });
    skinIndex.set(skin.partId, i);
    return {
      name: skeleton.name,
      joints: skeleton.bones.map((b) => boneNode.get(b.id)!),
      inverseBindMatrices: w.accessor(ibm, 'MAT4'),
      extras: { ep_id: skeleton.id },
    };
  });
  for (const s of doc.skeletons)
    if (!doc.skins.some((k) => k.skeletonId === s.id)) w.loss('skeleton-without-skin');

  // Meshes: one per part.
  const gltfMeshes: J[] = [];
  for (const p of doc.parts) {
    const mesh = meshes.get(p.mesh)!;
    const skin = doc.skins.find((s) => s.partId === p.id);
    const skeleton = skin && doc.skeletons.find((s) => s.id === skin.skeletonId)!;
    const node = nodes[partNode.get(p.id)!];
    node.mesh = gltfMeshes.length;
    if (skin) node.skin = skinIndex.get(p.id)!;
    gltfMeshes.push(
      meshOut(
        w,
        doc,
        p.name,
        mesh,
        skeleton?.bones.map((b) => b.id),
        (slot) => {
          const id = p.materials[slot];
          return id === undefined ? undefined : materialIndex.get(id);
        },
      ),
    );
  }

  const animations = doc.actions
    .map((a) => animationOut(w, doc, a, partNode, boneNode, meshes))
    .filter((a): a is J => a !== undefined);

  if (doc.props.length) w.loss('prop', doc.props.length);
  for (const s of doc.skeletons)
    for (const c of s.ik ?? []) w.loss(c.enabled ? 'ik-baked' : 'ik-chain-disabled');

  const json: J = {
    asset: { version: '2.0', generator: 'editor-platform character (C6c)' },
    scene: 0,
    scenes: [{ name: doc.name, nodes: sceneNodes }],
    nodes,
    meshes: gltfMeshes,
    ...(materials.length ? { materials } : {}),
    ...(textures.length ? { textures, images: gltfImages } : {}),
    ...(skins.length ? { skins } : {}),
    ...(animations.length ? { animations } : {}),
    accessors: w.accessors,
    bufferViews: w.bufferViews,
    buffers: [{ byteLength: w.length }],
  };
  return {
    bytes: glb(json, w.chunks, w.length),
    losses: [...w.losses]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([c, n]) => (n > 1 ? `${c} ×${n}` : c)),
  };
}

/** One part's mesh: vertices per distinct (vertex, normal, UV) corner, a primitive per slot. */
function meshOut(
  w: Writer,
  doc: CharacterDocument,
  name: string,
  mesh: EpmMesh,
  joints: string[] | undefined,
  material: (slot: number) => number | undefined,
): J {
  if (!mesh.faceSizes.length) fail('document', `part ${name}: its mesh has no faces`);
  const normals = cornerNormals(mesh);
  const corners = mesh.faceIndices.length;
  const vertexOf = new Map<string, number>();
  const cornerOut = new Uint32Array(corners);
  const source: number[] = [],
    sourceCorner: number[] = [];
  for (let c = 0; c < corners; c++) {
    const v = mesh.faceIndices[c];
    const key = [
      v,
      normals[3 * c],
      normals[3 * c + 1],
      normals[3 * c + 2],
      ...(mesh.uvs ? [mesh.uvs[2 * c], mesh.uvs[2 * c + 1]] : []),
    ].join(',');
    let out = vertexOf.get(key);
    if (out === undefined) {
      out = source.length;
      vertexOf.set(key, out);
      source.push(v);
      sourceCorner.push(c);
    }
    cornerOut[c] = out;
  }
  const n = source.length;
  const pos = new Float32Array(3 * n),
    nor = new Float32Array(3 * n);
  const uv = mesh.uvs ? new Float32Array(2 * n) : undefined;
  source.forEach((v, i) => {
    pos.set(pointOut(mesh.positions, 3 * v), 3 * i);
    const c = sourceCorner[i];
    const d = vecOut(normals, 3 * c);
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    nor.set([d[0] / l, d[1] / l, d[2] / l], 3 * i);
    // The mesh's v runs up the image, glTF's down (the importer flips it back).
    if (uv) uv.set([mesh.uvs![2 * c], 1 - mesh.uvs![2 * c + 1]], 2 * i);
  });
  const attributes: J = {
    POSITION: w.accessor(pos, 'VEC3', ARRAY_BUFFER),
    NORMAL: w.accessor(nor, 'VEC3', ARRAY_BUFFER),
  };
  if (uv) attributes.TEXCOORD_0 = w.accessor(uv, 'VEC2', ARRAY_BUFFER);
  if (mesh.weights && joints) {
    const four = fourInfluences(mesh);
    const jointOf = mesh.boneIds.map((id) => joints.indexOf(id));
    const j = new Uint16Array(4 * n),
      wt = new Float32Array(4 * n);
    let over = 0,
      unweighted = 0;
    const counted = new Set<number>();
    source.forEach((v, i) => {
      const count = mesh.weights!.offsets[v + 1] - mesh.weights!.offsets[v];
      if (!counted.has(v)) {
        counted.add(v);
        if (count > 4) over++;
        if (count === 0) unweighted++;
      }
      if (count === 0) {
        // glTF needs weights that sum to 1: an unweighted vertex follows the first joint.
        wt[4 * i] = 1;
        return;
      }
      for (let k = 0; k < 4; k++) {
        j[4 * i + k] = four.skinWeight[4 * v + k] > 0 ? jointOf[four.skinIndex[4 * v + k]] : 0;
        wt[4 * i + k] = four.skinWeight[4 * v + k];
      }
    });
    w.loss('more-than-four-influences', over);
    w.loss('unweighted-vertices', unweighted);
    attributes.JOINTS_0 = w.accessor(j, 'VEC4', ARRAY_BUFFER);
    attributes.WEIGHTS_0 = w.accessor(wt, 'VEC4', ARRAY_BUFFER);
  } else if (mesh.weights) w.loss('weights-without-skin');
  const names = new Map(doc.morphs.map((m) => [m.id, m]));
  const targets = mesh.morphs.map((m) => {
    const d = new Float32Array(3 * n);
    source.forEach((v, i) => d.set(pointOut(m.deltas, 3 * v), 3 * i));
    return { POSITION: w.accessor(d, 'VEC3', ARRAY_BUFFER) };
  });
  // Triangles per material slot, in slot order.
  const bySlot = new Map<number, number[]>();
  let start = 0,
    polygons = 0;
  for (let f = 0; f < mesh.faceSizes.length; f++) {
    const size = mesh.faceSizes[f];
    if (size > 3) polygons++;
    const list = bySlot.get(mesh.faceMaterials[f]) ?? [];
    for (const k of triangulateFace(mesh, start, size)) list.push(cornerOut[start + k]);
    bySlot.set(mesh.faceMaterials[f], list);
    start += size;
  }
  w.loss('polygons-triangulated', polygons);
  if (mesh.creases?.edges.length) w.loss('crease');
  const primitives = [...bySlot.keys()]
    .sort((a, b) => a - b)
    .map((slot) => {
      const m = material(slot);
      return {
        attributes,
        indices: w.accessor(Uint32Array.from(bySlot.get(slot)!), 'SCALAR', ELEMENT_ARRAY_BUFFER),
        ...(m === undefined ? {} : { material: m }),
        ...(targets.length ? { targets } : {}),
      };
    });
  const out: J = { name, primitives };
  if (mesh.morphs.length) {
    out.weights = mesh.morphs.map((m) => names.get(m.id)?.weight ?? 0);
    out.extras = {
      targetNames: mesh.morphs.map((m) => names.get(m.id)?.name ?? m.id),
      ep_morph_ids: mesh.morphs.map((m) => m.id),
    };
  }
  return out;
}

interface Channel {
  node: number;
  path: 'translation' | 'rotation' | 'scale' | 'weights';
  ticks: number[];
  /** Per tick: a Vec3, a Quat, or the part's morph weights. */
  values: number[][];
  interpolation: 'LINEAR' | 'STEP';
}

/** Linear or hold keys (the last key's easing leads nowhere) copy as LINEAR or STEP. */
function copyable(keys: readonly CharacterKey[]): 'LINEAR' | 'STEP' | undefined {
  const lead = keys.slice(0, -1);
  if (lead.every((k) => k.easing.type === 'linear')) return 'LINEAR';
  if (lead.every((k) => k.easing.type === 'hold')) return 'STEP';
  return undefined;
}

/** Every frame of the action at its rate, and its last tick. */
function frameTicks(a: CharacterAction): number[] {
  const step = (240000 * a.frameRate.denominator) / a.frameRate.numerator;
  // As many samples as a track may hold keys, checked before anything is allocated.
  if (Math.ceil(a.duration / step) + 1 > characterLimits.keysPerTrack)
    fail('limit', `action ${a.id}: too many frames to bake`);
  const out: number[] = [];
  for (let k = 0; k * step < a.duration; k++) {
    const tick = Math.round(k * step);
    if (tick !== out[out.length - 1]) out.push(tick);
  }
  if (out[out.length - 1] !== a.duration) out.push(a.duration);
  return out;
}

function animationOut(
  w: Writer,
  doc: CharacterDocument,
  action: CharacterAction,
  partNode: ReadonlyMap<string, number>,
  boneNode: ReadonlyMap<string, number>,
  meshes: ReadonlyMap<string, EpmMesh>,
): J | undefined {
  const channels: Channel[] = [];
  // Only baked tracks need the frames: linear and held keys are copied.
  let frameList: number[] | undefined;
  const frames = () => (frameList ??= frameTicks(action));
  const poses = new Map<number, ReturnType<typeof poseAt>>();
  const ik = doc.skeletons.some((s) => s.ik?.some((c) => c.enabled));
  const solved = new Map<number, Map<string, { rotation: Quat }>>();
  const pose = (tick: number) => {
    let p = poses.get(tick);
    if (!p) poses.set(tick, (p = poseAt(doc, action, tick)));
    return p;
  };
  const solvedAt = (tick: number) => {
    let s = solved.get(tick);
    if (!s) solved.set(tick, (s = solvedBones(doc, pose(tick))));
    return s;
  };
  // Bones an enabled IK chain turns: their rotation is baked from the solution.
  const ikBones = new Set<string>();
  if (ik)
    for (const s of doc.skeletons)
      for (const c of s.ik ?? [])
        if (c.enabled) for (const b of ikChainBones(s, c)?.bones ?? []) ikBones.add(b.id);
  const convert = (prop: 'translation' | 'rotation' | 'scale', v: Vec3 | Quat): number[] =>
    prop === 'translation'
      ? pointOut(v)
      : prop === 'rotation'
        ? rotationOut(v as Quat)
        : scaleOut(v as Vec3);
  let baked = 0,
    props = 0;
  for (const track of action.tracks) {
    const t = track.target;
    if (t.kind === 'prop-joint') {
      props++;
      continue;
    }
    if (t.kind === 'morph') continue;
    const node = t.kind === 'part' ? partNode.get(t.id) : boneNode.get(t.id);
    if (node === undefined) continue;
    if (t.kind === 'bone' && t.property === 'rotation' && ikBones.has(t.id)) continue;
    const interpolation = copyable(track.keys);
    if (interpolation)
      channels.push({
        node,
        path: t.property,
        ticks: track.keys.map((k) => k.tick),
        values: track.keys.map((k) => convert(t.property, k.value as Vec3 | Quat)),
        interpolation,
      });
    else {
      baked++;
      channels.push({
        node,
        path: t.property,
        ticks: frames(),
        values: frames().map((tick) => {
          const p = pose(tick);
          const local = (t.kind === 'part' ? p.parts : p.bones).get(t.id)!;
          return convert(t.property, local[t.property]);
        }),
        interpolation: 'LINEAR',
      });
    }
  }
  for (const id of ikBones)
    channels.push({
      node: boneNode.get(id)!,
      path: 'rotation',
      ticks: frames(),
      values: frames().map((tick) => rotationOut(solvedAt(tick).get(id)!.rotation)),
      interpolation: 'LINEAR',
    });
  // Morph weights: one channel per part, every morph of its mesh at each time.
  for (const p of doc.parts) {
    const mesh = meshes.get(p.mesh)!;
    const ids = mesh.morphs.map((m) => m.id);
    const tracks = action.tracks.filter(
      (tr) => tr.target.kind === 'morph' && ids.includes(tr.target.id),
    );
    if (!tracks.length) continue;
    const kinds = new Set(tracks.map((tr) => copyable(tr.keys)));
    const interpolation = kinds.size === 1 ? [...kinds][0] : undefined;
    // Linear (or held) keys of several morphs are exact at the union of their times.
    const ticks = interpolation
      ? [...new Set(tracks.flatMap((tr) => tr.keys.map((k) => k.tick)))].sort((a, b) => a - b)
      : frames();
    if (!interpolation) baked += tracks.length;
    channels.push({
      node: partNode.get(p.id)!,
      path: 'weights',
      ticks,
      values: ticks.map((tick) => ids.map((id) => pose(tick).morphs.get(id) ?? 0)),
      interpolation: interpolation ?? 'LINEAR',
    });
  }
  w.loss('prop-joint-track', props);
  w.loss('eased-keys-baked', baked);
  if (!channels.length) {
    w.loss('empty-action');
    return undefined;
  }
  if (action.frameRate.numerator !== 30 || action.frameRate.denominator !== 1) w.loss('frame-rate');
  // The importer's duration is the last key: carry the action's end on the first channel.
  if (Math.max(...channels.map((c) => c.ticks[c.ticks.length - 1])) < action.duration) {
    const c = channels[0];
    c.ticks = [...c.ticks, action.duration];
    c.values = [...c.values, c.values[c.values.length - 1]];
  }
  const samplers: J[] = [];
  const out: J[] = [];
  let rounded = 0;
  for (const c of channels) {
    const times = Float32Array.from(c.ticks, (tick) => tick / 240000);
    times.forEach((t, k) => {
      if (Math.round(t * 240000) !== c.ticks[k]) rounded++;
      // Keys close together late in a long action can meet in float32 seconds: a sampler's
      // times must increase, so such an action is refused rather than written unreadable.
      if (k > 0 && !(t > times[k - 1]))
        fail('limit', `action ${action.id}: key times collide in float32 seconds`);
    });
    if (c.path === 'rotation')
      // Keep neighbouring quaternions on one hemisphere, so every player takes the short arc.
      for (let k = 1; k < c.values.length; k++) {
        const a = c.values[k - 1],
          b = c.values[k];
        if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0)
          c.values[k] = b.map((x) => -x);
      }
    const type = c.path === 'rotation' ? 'VEC4' : c.path === 'weights' ? 'SCALAR' : 'VEC3';
    samplers.push({
      input: w.accessor(times, 'SCALAR'),
      output: w.accessor(Float32Array.from(c.values.flat()), type),
      interpolation: c.interpolation,
    });
    out.push({ sampler: samplers.length - 1, target: { node: c.node, path: c.path } });
  }
  w.loss('key-time-rounding', rounded);
  return { name: action.name, channels: out, samplers, extras: { ep_id: action.id } };
}

/** The GLB container: a JSON chunk padded with spaces, then the BIN chunk. */
function glb(json: J, chunks: Uint8Array[], length: number): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(text.length / 4) * 4;
  const total = 12 + 8 + jsonLength + (length ? 8 + length : 0);
  if (total > gltfExportLimits.fileBytes) fail('limit', 'file bytes');
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLength);
  if (length) {
    let at = 20 + jsonLength;
    view.setUint32(at, length, true);
    view.setUint32(at + 4, 0x004e4942, true);
    at += 8;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
  }
  return out;
}
