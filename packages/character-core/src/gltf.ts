import { geometryTextureImageSize, type GeometryTextureRole } from '@editor-platform/geometry-core';
import {
  encodeEpm,
  epmLimits,
  epmSha256,
  MeshAssetError,
  type EpmMesh,
} from '@editor-platform/geometry-mesh';
import {
  composeMat4,
  decomposeMat4,
  identityMat4,
  invertMat4,
  multiplyMat4,
  multiplyQuat,
  normalizeQuat,
  type Mat4,
} from './math';
import {
  characterAssetMediaTypes,
  characterLimits,
  emptyCharacter,
  type CharacterAction,
  type CharacterBone,
  type CharacterDocument,
  type CharacterKey,
  type CharacterMaterial,
  type CharacterTrack,
  type Quat,
  type Transform3,
  type Vec3,
} from './model';
import { checkCharacterMeshes, validateCharacter } from './validation';

/**
 * C1 (#680): reads a glTF 2.0 file (GLB, or glTF JSON with `data:` buffers) or a VRM into a
 * schema 1 document and its assets. Meshes become EPM assets, units go from metres Y-up to mm
 * Z-up, skins and animations keep their joints and keys. IDs come from `extras.ep_id` when the
 * file has them, else from names, so a re-import of the same model keeps them. Anything the
 * document cannot hold is either listed in `losses` or refused with `GltfImportError`; the file is
 * data only (no URL is fetched, nothing runs).
 */
export interface GltfImport {
  doc: CharacterDocument;
  /** Asset bytes by asset ID: one EPM per part and one image per texture. */
  assets: Map<string, Uint8Array>;
  meshes: Map<string, EpmMesh>;
  /** What was not carried over, as stable codes with a count (`cubic-spline-tangents ×3`). */
  losses: string[];
  /** VRM's metadata, shown to the user as the model's terms of use. */
  vrm?: { version: '0' | '1'; meta: Record<string, string> };
}
export type GltfImportProblem =
  | 'too-large'
  | 'container'
  | 'json'
  | 'version'
  | 'required-extension'
  | 'external-uri'
  | 'buffer'
  | 'accessor'
  | 'sparse'
  | 'primitive'
  | 'node'
  | 'skin'
  | 'animation'
  | 'image'
  | 'id'
  | 'limit'
  | 'document';
export class GltfImportError extends Error {
  constructor(
    readonly problem: GltfImportProblem,
    readonly detail: string,
  ) {
    super(`gltf-import: ${problem}: ${detail}`);
    this.name = 'GltfImportError';
  }
}
const fail = (problem: GltfImportProblem, detail: string): never => {
  throw new GltfImportError(problem, detail);
};
/** An ID within the limit: the candidate itself, or its prefix and a digest of the rest. */
function shortId(candidate: string): string {
  if ([...candidate].length <= characterLimits.idCodePoints) return candidate;
  const prefix = candidate.slice(0, candidate.indexOf(':') + 1);
  return `${prefix}${epmSha256(new TextEncoder().encode(candidate)).slice(7, 39)}`;
}

export const gltfImportLimits = Object.freeze({
  fileBytes: 256 * 1024 * 1024,
  jsonBytes: 32 * 1024 * 1024,
  imageBytes: 16 * 1024 * 1024,
  imagePixels: 4096,
  nodes: 4096,
  animations: characterLimits.actions,
  /** Numbers decoded from all accessors together (positions, indices, keys …). */
  decodedValues: 64_000_000,
});
/**
 * Read without refusing the file (even when required), but what they add is not kept: each one
 * used is listed as a loss `extension:<name>`.
 */
const droppedExtensions = new Set([
  'KHR_materials_emissive_strength',
  'KHR_materials_unlit',
  'KHR_materials_specular',
  'KHR_materials_ior',
  'VRMC_materials_mtoon',
  'VRMC_node_constraint',
]);
/** Extensions the reader understands, or drops with a loss (`droppedExtensions`). */
const knownExtensions = new Set([
  'KHR_materials_emissive_strength',
  'KHR_materials_unlit',
  'KHR_texture_transform',
  'KHR_materials_specular',
  'KHR_materials_ior',
  'VRM',
  'VRMC_vrm',
  'VRMC_springBone',
  'VRMC_materials_mtoon',
  'VRMC_node_constraint',
]);

type J = Record<string, unknown>;
type AccessorType = 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT4';
const obj = (v: unknown): J =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const int = (v: unknown, what: string, max = Number.MAX_SAFE_INTEGER): number =>
  Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max
    ? (v as number)
    : fail('json', what);
const nums = (v: unknown, n: number, what: string, fallback?: number[]): number[] => {
  if (v === undefined && fallback) return fallback;
  if (
    !Array.isArray(v) ||
    v.length !== n ||
    !v.every((x) => typeof x === 'number' && Number.isFinite(x))
  )
    fail('json', what);
  return v as number[];
};

/** glTF (m, Y-up) → mm, Z-up: x stays, y → z, z → −y, ×1000. */
const A: Mat4 = [1000, 0, 0, 0, 0, 0, 1000, 0, 0, -1000, 0, 0, 0, 0, 0, 1];
const Ainv: Mat4 = invertMat4(A)!;
const point = (p: number[]): Vec3 => [1000 * p[0], -1000 * p[2], 1000 * p[1]];
/** Rotation of +90° about x: the basis change without the scale. */
const qC: Quat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const qCinv: Quat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const rotation = (q: number[]): Quat => {
  const r = normalizeQuat(multiplyQuat(multiplyQuat(qC, q as Quat), qCinv));
  return r[3] < 0 ? [-r[0], -r[1], -r[2], -r[3]] : r;
};
const scale = (s: number[]): Vec3 => [s[0], s[2], s[1]];
const convertMatrix = (m: Mat4): Mat4 => multiplyMat4(multiplyMat4(A, m), Ainv);
const convertTransform = (t: Transform3): Transform3 => ({
  translation: point(t.translation),
  rotation: rotation(t.rotation),
  scale: scale(t.scale),
});

/** Reads GLB bytes, or glTF JSON bytes whose buffers are `data:` URIs. */
/** Authored normals more than about 10° from the rebuilt ones are reported as a loss. */
const authoredNormalCos = Math.cos((10 * Math.PI) / 180);

/** Two affine matrices agree to float precision (relative to their size). */
function sameMat4(a: Mat4, b: Mat4): boolean {
  // The linear part and the translation are compared separately: they carry different units.
  const close = (ks: number[]) => {
    let size = 1,
      diff = 0;
    for (const k of ks) {
      size = Math.max(size, Math.abs(a[k]), Math.abs(b[k]));
      diff = Math.max(diff, Math.abs(a[k] - b[k]));
    }
    return diff <= 1e-5 * size;
  };
  return close([0, 1, 2, 4, 5, 6, 8, 9, 10]) && close([12, 13, 14]);
}

export function importGltf(bytes: Uint8Array): GltfImport {
  if (bytes.length > gltfImportLimits.fileBytes) fail('too-large', `${bytes.length} bytes`);
  const { json, bin } = container(bytes);
  return new Reader(json, bin).read();
}

function container(bytes: Uint8Array): { json: J; bin?: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (b: Uint8Array) => {
    if (b.length > gltfImportLimits.jsonBytes) fail('too-large', 'json');
    try {
      return obj(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)));
    } catch {
      return fail('json', 'parse');
    }
  };
  if (bytes.length >= 12 && view.getUint32(0, true) === 0x46546c67) {
    if (view.getUint32(4, true) !== 2) fail('version', 'GLB version');
    const length = view.getUint32(8, true);
    if (length !== bytes.length) fail('container', 'length');
    let at = 12;
    let json: J | undefined;
    let bin: Uint8Array | undefined;
    while (at < length) {
      if (at + 8 > length) fail('container', 'chunk header');
      const size = view.getUint32(at, true),
        type = view.getUint32(at + 4, true);
      if (at + 8 + size > length) fail('container', 'chunk length');
      const data = bytes.subarray(at + 8, at + 8 + size);
      if (type === 0x4e4f534a) {
        if (json) fail('container', 'second JSON chunk');
        json = text(data);
      } else if (type === 0x004e4942) {
        if (!json || bin) fail('container', 'BIN chunk order');
        bin = data;
      }
      at += 8 + size;
    }
    if (!json) fail('container', 'no JSON chunk');
    return { json: json!, bin };
  }
  return { json: text(bytes) };
}

interface Prim {
  positions: number[][];
  normals?: number[][];
  uvs?: number[][];
  joints?: number[][];
  weights?: number[][];
  indices: number[];
  material: number | undefined;
  targets: number[][][];
}

class Reader {
  losses = new Map<string, number>();
  /** Skeleton id → the mesh node its roots sit under (resolved to a part after `readParts`). */
  skeletonAnchor = new Map<string, number>();
  buffers: Uint8Array[] = [];
  doc = emptyCharacter('Imported');
  assets = new Map<string, Uint8Array>();
  meshes = new Map<string, EpmMesh>();
  ids = new Set<string>();
  /** glTF material index → material ID; −1 is the default material. */
  materialIds = new Map<number, string>();
  imageAssets = new Map<number, string>();
  nodeParent = new Map<number, number>();
  nodePart = new Map<number, string>();
  jointBone = new Map<number, string>();
  /**
   * Per bone or part node: the static transform from its kept parent (bone, part, or the scene
   * when it has none) to its own parent node. Rest poses and animation keys both use it.
   */
  /** Per joint node, the static transform above its bone (folded into rest and keys). */
  boneAbove = new Map<number, Mat4>();
  /** Per mesh node, the static transform above its part. */
  partAbove = new Map<number, Mat4>();
  /** Accessor elements decoded so far, bounded before anything is allocated. */
  decoded = 0;
  constructor(
    readonly json: J,
    readonly bin: Uint8Array | undefined,
  ) {}
  loss(code: string, n = 1) {
    this.losses.set(code, (this.losses.get(code) ?? 0) + n);
  }
  claim(id: string, what: string) {
    if ([...id].length > characterLimits.idCodePoints) fail('id', `${what} ep_id too long`);
    if (this.ids.has(id)) fail('id', `duplicate ${id}`);
    this.ids.add(id);
    return id;
  }
  /** `extras.ep_id` (ADR 019), else a prefix and the name, else the index. */
  idOf(item: J, prefix: string, fallback: string): string {
    const ep = obj(item.extras).ep_id;
    if (ep !== undefined) {
      if (typeof ep !== 'string' || !ep.trim() || ep.trim() !== ep || /\p{Cc}/u.test(ep))
        fail('id', `${prefix} ep_id`);
      return ep as string;
    }
    return shortId(`${prefix}:${fallback}`);
  }
  /** A node's ID: its ep_id, else its name, else (name taken or empty) its path of names. */
  nodeId(nodes: unknown[], i: number, prefix: string): string {
    const node = obj(nodes[i]);
    if (obj(node.extras).ep_id !== undefined) return this.idOf(node, prefix, '');
    const name = typeof node.name === 'string' && node.name ? node.name : '';
    const byName = shortId(`${prefix}:${name}`);
    return name && !this.ids.has(byName) && !this.sameName(nodes, i, name)
      ? byName
      : shortId(`${prefix}:${this.path(nodes, i)}`);
  }
  /** Another node has the same name: neither takes the bare name, so the IDs do not depend on order. */
  sameName(nodes: unknown[], i: number, name: string): boolean {
    return nodes.some((n, k) => k !== i && obj(n).name === name);
  }
  read(): GltfImport {
    const asset = obj(this.json.asset);
    if (typeof asset.version !== 'string' || !/^2\.\d+$/.test(asset.version))
      fail('version', 'asset.version');
    for (const e of arr(this.json.extensionsRequired))
      if (!knownExtensions.has(e as string)) fail('required-extension', String(e));
    const used = arr(this.json.extensionsUsed).map(String);
    for (const e of used)
      if (!knownExtensions.has(e) || droppedExtensions.has(e)) this.loss(`extension:${e}`);
    if (used.includes('KHR_texture_transform')) this.loss('texture-transform');
    this.readBuffers();
    const nodes = arr(this.json.nodes);
    if (nodes.length > gltfImportLimits.nodes) fail('limit', 'nodes');
    nodes.forEach((n, i) =>
      arr(obj(n).children).forEach((c) => {
        const child = int(c, `nodes[${i}].children`, nodes.length - 1);
        if (this.nodeParent.has(child)) fail('node', `node ${child} has two parents`);
        this.nodeParent.set(child, i);
      }),
    );
    for (const i of this.nodeParent.keys()) {
      const seen = new Set<number>();
      for (let at: number | undefined = i; at !== undefined; at = this.nodeParent.get(at)) {
        if (seen.has(at)) fail('node', 'cycle');
        seen.add(at);
      }
    }
    const sceneIndex = this.json.scene === undefined ? 0 : int(this.json.scene, 'scene');
    const scene = obj(arr(this.json.scenes)[sceneIndex]);
    const roots = arr(scene.nodes).map((n) => int(n, 'scene.nodes', nodes.length - 1));
    const inScene = new Set<number>();
    // Iterative: a chain of every permitted node must not exhaust the stack.
    const stack = [...roots];
    while (stack.length) {
      const i = stack.pop()!;
      if (inScene.has(i)) continue;
      inScene.add(i);
      for (const c of arr(obj(nodes[i]).children)) stack.push(c as number);
    }
    if (typeof scene.name === 'string' && scene.name.trim())
      this.doc.name = [...scene.name].slice(0, characterLimits.nameCodePoints).join('');
    this.readSkins(nodes, inScene);
    this.readParts(nodes, inScene);
    for (const s of this.doc.skeletons) {
      const anchor = this.skeletonAnchor.get(s.id);
      if (anchor !== undefined) s.parentPartId = this.nodePart.get(anchor) ?? null;
    }
    this.readAnimations(nodes);
    const vrm = this.readVrm();
    if (this.doc.parts.length === 0) fail('primitive', 'no mesh in the scene');
    const diagnostics = [
      ...validateCharacter(this.doc),
      ...checkCharacterMeshes(this.doc, this.meshes),
    ];
    if (diagnostics.length)
      fail(
        'document',
        diagnostics
          .slice(0, 5)
          .map((d) => `${d.code} ${d.path}`)
          .join('; '),
      );
    return {
      doc: this.doc,
      assets: this.assets,
      meshes: this.meshes,
      losses: [...this.losses]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([c, n]) => (n > 1 ? `${c} ×${n}` : c)),
      ...(vrm ? { vrm } : {}),
    };
  }

  readBuffers() {
    arr(this.json.buffers).forEach((b, i) => {
      const buf = obj(b);
      const length = int(buf.byteLength, `buffers[${i}].byteLength`);
      let data: Uint8Array;
      if (buf.uri === undefined) {
        if (i !== 0 || !this.bin) fail('buffer', `buffers[${i}] has no data`);
        data = this.bin!;
      } else if (typeof buf.uri === 'string' && buf.uri.startsWith('data:')) {
        data = dataUri(buf.uri);
      } else return fail('external-uri', `buffers[${i}]`);
      if (data.length < length) fail('buffer', `buffers[${i}] shorter than byteLength`);
      this.buffers.push(data.subarray(0, length));
    });
  }
  view(index: number): { bytes: Uint8Array; stride?: number } {
    const v = obj(arr(this.json.bufferViews)[index]);
    const buffer = this.buffers[int(v.buffer, `bufferViews[${index}].buffer`)];
    if (!buffer) fail('buffer', `bufferViews[${index}].buffer`);
    const offset = v.byteOffset === undefined ? 0 : int(v.byteOffset, 'byteOffset');
    const length = int(v.byteLength, 'byteLength');
    if (offset + length > buffer.length) fail('buffer', `bufferViews[${index}] range`);
    const stride = v.byteStride === undefined ? undefined : int(v.byteStride, 'byteStride', 252);
    return { bytes: buffer.subarray(offset, offset + length), stride };
  }
  /**
   * An accessor's elements as number arrays (normalised integers mapped to 0–1 / −1–1). `type`
   * is the element shape the use needs; any other shape is refused rather than read short.
   */
  accessor(index: unknown, what: string, type: AccessorType): number[][] {
    const a = obj(arr(this.json.accessors)[int(index, what)]);
    const sizes: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
    const n = sizes[a.type as string] ?? fail('accessor', `${what} type`);
    if (a.type !== type) fail('accessor', `${what} type ${String(a.type)} (needs ${type})`);
    const count = int(a.count, `${what} count`, 50_000_000);
    // Zero-filled and sparse accessors are not bounded by the file's bytes: bound every read.
    this.decoded += count * n;
    if (this.decoded > gltfImportLimits.decodedValues) fail('too-large', `${what} decoded values`);
    const kinds: Record<number, [number, (v: DataView, o: number) => number, number]> = {
      5120: [1, (v, o) => v.getInt8(o), 127],
      5121: [1, (v, o) => v.getUint8(o), 255],
      5122: [2, (v, o) => v.getInt16(o, true), 32767],
      5123: [2, (v, o) => v.getUint16(o, true), 65535],
      5125: [4, (v, o) => v.getUint32(o, true), 0],
      5126: [4, (v, o) => v.getFloat32(o, true), 0],
    };
    const kind = kinds[a.componentType as number] ?? fail('accessor', `${what} componentType`);
    const out =
      a.bufferView === undefined
        ? Array.from({ length: count }, () => new Array<number>(n).fill(0))
        : this.dense(a.bufferView, a.byteOffset, count, n, kind, a.normalized === true, what);
    if (a.sparse === undefined) return out;
    // Sparse: `count` (index, value) pairs replace elements of the base (or of zeros).
    const sp = obj(a.sparse);
    const sc = int(sp.count, `${what} sparse.count`, count);
    const si = obj(sp.indices);
    const indexKind =
      ({ 5121: kinds[5121], 5123: kinds[5123], 5125: kinds[5125] } as const)[
        si.componentType as 5121
      ] ?? fail('sparse', `${what} indices componentType`);
    const indices = this.dense(si.bufferView, si.byteOffset, sc, 1, indexKind, false, what);
    const sv = obj(sp.values);
    const values = this.dense(
      sv.bufferView,
      sv.byteOffset,
      sc,
      n,
      kind,
      a.normalized === true,
      what,
    );
    let last = -1;
    for (let i = 0; i < sc; i++) {
      const at = indices[i][0];
      if (at <= last || at >= count) fail('sparse', `${what} indices`);
      last = at;
      out[at] = values[i];
    }
    return out;
  }
  private dense(
    view: unknown,
    byteOffset: unknown,
    count: number,
    n: number,
    [size, get, max]: [number, (v: DataView, o: number) => number, number],
    normalized: boolean,
    what: string,
  ): number[][] {
    const { bytes, stride } = this.view(int(view, `${what} bufferView`));
    const offset = byteOffset === undefined ? 0 : int(byteOffset, `${what} byteOffset`);
    const step = stride ?? n * size;
    if (count > 0 && offset + step * (count - 1) + n * size > bytes.length)
      fail('accessor', `${what} range`);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out: number[][] = new Array(count);
    for (let i = 0; i < count; i++) {
      const e = new Array<number>(n);
      for (let k = 0; k < n; k++) {
        let x = get(dv, offset + i * step + k * size);
        if (normalized && max) x = Math.max(x / max, -1);
        if (!Number.isFinite(x)) fail('accessor', `${what} not finite`);
        e[k] = x;
      }
      out[i] = e;
    }
    return out;
  }

  material(index: number | undefined): string {
    const key = index ?? -1;
    const done = this.materialIds.get(key);
    if (done) return done;
    if (index === undefined) {
      const id = this.claim('material:default', 'material');
      this.doc.materials.push({
        id,
        name: 'Default',
        // glTF's default material: white, fully metallic, fully rough.
        color: '#ffffff',
        opacity: 1,
        roughness: 1,
        metalness: 1,
        maps: {},
        doubleSided: false,
      });
      this.materialIds.set(key, id);
      return id;
    }
    const m = obj(arr(this.json.materials)[index]);
    const name = typeof m.name === 'string' ? m.name : `#${index}`;
    const id = this.claim(this.idOf(m, 'material', name), 'material');
    const pbr = obj(m.pbrMetallicRoughness);
    const base = nums(pbr.baseColorFactor, 4, 'baseColorFactor', [1, 1, 1, 1]);
    const maps: CharacterMaterial['maps'] = {};
    const texture = (info: unknown, role: GeometryTextureRole) => {
      const t = obj(info);
      if (info === undefined) return;
      if (t.texCoord !== undefined && t.texCoord !== 0) return this.loss('second-uv-set');
      if (obj(t.extensions).KHR_texture_transform) this.loss('texture-transform');
      const tex = obj(arr(this.json.textures)[int(t.index, 'texture index')]);
      // Maps keep only the image: wrapping other than REPEAT and nearest filtering are lost.
      if (tex.sampler !== undefined) {
        const sm = obj(arr(this.json.samplers)[int(tex.sampler, 'texture sampler')]);
        const nearest = [9728, 9984, 9986];
        if (
          [sm.wrapS, sm.wrapT].some((w) => w !== undefined && w !== 10497) ||
          [sm.magFilter, sm.minFilter].some((f) => nearest.includes(f as number))
        )
          this.loss('texture-sampler');
      }
      const source = tex.source;
      if (source === undefined) return this.loss('texture-without-image');
      maps[role] = this.image(int(source, 'texture source'));
    };
    texture(pbr.baseColorTexture, 'color');
    texture(m.normalTexture, 'normal');
    texture(m.occlusionTexture, 'occlusion');
    // Maps keep only the image: a normal scale or occlusion strength other than 1 is lost.
    const modifier = (info: unknown, key: string) => {
      const x = obj(info)[key];
      return info !== undefined && x !== undefined && x !== 1;
    };
    if (modifier(m.normalTexture, 'scale') || modifier(m.occlusionTexture, 'strength'))
      this.loss('texture-strength');
    if (pbr.metallicRoughnessTexture !== undefined) this.loss('metallic-roughness-texture');
    if (m.emissiveTexture !== undefined || m.emissiveFactor !== undefined) this.loss('emissive');
    if (m.alphaMode === 'MASK') this.loss('alpha-mask');
    // Only a uniform opacity is kept: blending by the colour texture's alpha is lost.
    if (m.alphaMode === 'BLEND' && maps.color !== undefined) this.loss('alpha-texture');
    const clamp = (x: unknown, d: number) =>
      typeof x === 'number' && Number.isFinite(x) ? Math.min(Math.max(x, 0), 1) : d;
    this.doc.materials.push({
      id,
      name: [...name].slice(0, characterLimits.nameCodePoints).join(''),
      color: srgbHex(base),
      opacity: m.alphaMode === 'BLEND' ? clamp(base[3], 1) : 1,
      roughness: clamp(pbr.roughnessFactor, 1),
      metalness: clamp(pbr.metallicFactor, 1),
      maps,
      doubleSided: m.doubleSided === true,
    });
    this.materialIds.set(key, id);
    return id;
  }
  image(index: number): string {
    const done = this.imageAssets.get(index);
    if (done) return done;
    const img = obj(arr(this.json.images)[index]);
    let bytes: Uint8Array;
    if (img.bufferView !== undefined)
      bytes = this.view(int(img.bufferView, 'image bufferView')).bytes.slice();
    else if (typeof img.uri === 'string' && img.uri.startsWith('data:')) bytes = dataUri(img.uri);
    else return fail('external-uri', `images[${index}]`);
    if (bytes.length > gltfImportLimits.imageBytes) fail('image', `images[${index}] too large`);
    const png = bytes[0] === 0x89 && bytes[1] === 0x50;
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const size = geometryTextureImageSize(bytes);
    if ((!png && !jpeg) || !size) fail('image', `images[${index}] is not a PNG or JPEG`);
    if (Math.max(...size!) > gltfImportLimits.imagePixels)
      fail('image', `images[${index}] over ${gltfImportLimits.imagePixels} px`);
    const kind = png ? 'texture-png' : 'texture-jpeg';
    const sha = epmSha256(bytes);
    const existing = this.doc.assets.find((a) => a.sha256 === sha);
    if (existing) {
      this.imageAssets.set(index, existing.id);
      return existing.id;
    }
    const id = this.claim(`image:${sha.slice(7, 23)}`, 'image');
    this.doc.assets.push({
      id,
      kind,
      sha256: sha,
      byteLength: bytes.length,
      mediaType: characterAssetMediaTypes[kind],
    });
    this.assets.set(id, bytes);
    this.imageAssets.set(index, id);
    return id;
  }

  local(node: J): Mat4 {
    if (node.matrix !== undefined) return nums(node.matrix, 16, 'node.matrix');
    return composeMat4({
      translation: nums(node.translation, 3, 'translation', [0, 0, 0]) as Vec3,
      rotation: normalizeQuat(nums(node.rotation, 4, 'rotation', [0, 0, 0, 1]) as Quat),
      scale: nums(node.scale, 3, 'scale', [1, 1, 1]) as Vec3,
    });
  }
  /** The node's own TRS, signs as written (a `matrix` node is decomposed). */
  localTrs(node: J): Transform3 {
    if (node.matrix !== undefined)
      return decomposeMat4(this.local(node)) ?? fail('node', 'singular node.matrix');
    return {
      translation: nums(node.translation, 3, 'translation', [0, 0, 0]) as Vec3,
      rotation: normalizeQuat(nums(node.rotation, 4, 'rotation', [0, 0, 0, 1]) as Quat),
      scale: nums(node.scale, 3, 'scale', [1, 1, 1]) as Vec3,
    };
  }
  /**
   * `decomposeMat4` that reports a matrix TRS cannot hold (shear, from a non-uniform scale above
   * a rotation) as the loss `shear` instead of keeping the approximation silently.
   */
  trs(m: Mat4, signs?: readonly number[]): Transform3 | null {
    const t = decomposeMat4(m, signs);
    if (t && !sameMat4(composeMat4(t), m)) this.loss('shear');
    return t;
  }
  /** World matrix of a node in glTF space at rest. */
  world(nodes: unknown[], i: number): Mat4 {
    // Up the chain without recursion (a deep hierarchy must not exhaust the stack).
    let m = this.local(obj(nodes[i]));
    for (let at = this.nodeParent.get(i); at !== undefined; at = this.nodeParent.get(at))
      m = multiplyMat4(this.local(obj(nodes[at])), m);
    return m;
  }
  path(nodes: unknown[], i: number): string {
    const name = (k: number) => {
      const n = obj(nodes[k]).name;
      return typeof n === 'string' && n ? n : `#${k}`;
    };
    const parts: string[] = [];
    for (let at: number | undefined = i; at !== undefined; at = this.nodeParent.get(at))
      parts.unshift(name(at));
    return parts.join('/');
  }

  /**
   * The transform above node `i` up to its kept parent `kept`: the world of `i`'s parent node when
   * nothing is kept, else the product of the nodes `between` (nearest first) that are dropped.
   */
  above(nodes: unknown[], i: number, kept: number | undefined, between: number[]): Mat4 {
    if (kept === undefined) {
      const p = this.nodeParent.get(i);
      return p === undefined ? identityMat4() : this.world(nodes, p);
    }
    return between.reduceRight(
      (m, k) => multiplyMat4(m, this.local(obj(nodes[k]))),
      identityMat4(),
    );
  }

  readSkins(nodes: unknown[], inScene: Set<number>) {
    const used = new Set<number>();
    nodes.forEach((n, i) => {
      if (inScene.has(i) && obj(n).skin !== undefined)
        used.add(int(obj(n).skin, `nodes[${i}].skin`));
    });
    // Skins that share a joint are one skeleton (VRM splits face and body into skins this way).
    const skinJoints = new Map<number, number[]>();
    for (const s of [...used].sort((a, b) => a - b)) {
      const skin = obj(arr(this.json.skins)[s]);
      const joints = arr(skin.joints).map((j) => int(j, `skins[${s}].joints`, nodes.length - 1));
      if (!joints.length) fail('skin', `skins[${s}] has no joints`);
      skinJoints.set(s, joints);
    }
    const groups: { skins: number[]; joints: number[] }[] = [];
    for (const [s, joints] of skinJoints) {
      const touching = groups.filter((g) => joints.some((j) => g.joints.includes(j)));
      const merged = { skins: [s], joints: [...joints] };
      for (const g of touching) {
        merged.skins.unshift(...g.skins);
        merged.joints = [...g.joints, ...merged.joints.filter((j) => !g.joints.includes(j))];
        groups.splice(groups.indexOf(g), 1);
      }
      merged.skins.sort((a, b) => a - b);
      merged.joints = [...new Set(merged.joints)];
      groups.push(merged);
    }
    // A skeleton cannot move another: skins whose joints descend from another skin's joints
    // (disjoint lists, one hierarchy) are one skeleton too, so the animated ancestor carries them.
    for (let merged = true; merged; ) {
      merged = false;
      for (const a of groups) {
        const b = groups.find(
          (g) =>
            g !== a &&
            g.joints.some((j) => {
              for (let at = this.nodeParent.get(j); at !== undefined; at = this.nodeParent.get(at))
                if (a.joints.includes(at)) return true;
              return false;
            }),
        );
        if (!b) continue;
        a.skins = [...a.skins, ...b.skins].sort((x, y) => x - y);
        a.joints = [...new Set([...a.joints, ...b.joints])];
        groups.splice(groups.indexOf(b), 1);
        merged = true;
        break;
      }
    }
    groups.sort((a, b) => a.skins[0] - b.skins[0]);
    const depth = (j: number) => {
      let d = 0;
      for (let at = this.nodeParent.get(j); at !== undefined; at = this.nodeParent.get(at)) d++;
      return d;
    };
    for (const group of groups) {
      const skin = obj(arr(this.json.skins)[group.skins[0]]);
      const name = typeof skin.name === 'string' ? skin.name : `#${group.skins[0]}`;
      const skeletonId = this.claim(this.idOf(skin, 'skeleton', name), 'skeleton');
      const set = new Set(group.joints);
      // Parents before children, so every parent bone exists when its child is read.
      const joints = group.joints
        .map((j, k) => ({ j, k, d: depth(j) }))
        .sort((a, b) => a.d - b.d || a.k - b.k)
        .map((e) => e.j);
      // A skeleton whose roots all sit under one mesh node follows that part (its animation too).
      const meshAbove = (j: number) => {
        for (let at = this.nodeParent.get(j); at !== undefined; at = this.nodeParent.get(at))
          if (set.has(at)) return null;
          else if (obj(nodes[at]).mesh !== undefined && inScene.has(at)) return at;
        return undefined;
      };
      const anchors = new Set(group.joints.map(meshAbove).filter((a) => a !== null));
      const anchor = anchors.size === 1 ? [...anchors][0] : undefined;
      const bones: CharacterBone[] = [];
      for (const j of joints) {
        const node = obj(nodes[j]);
        const id = this.claim(this.nodeId(nodes, j, 'bone'), 'bone');
        this.jointBone.set(j, id);
        let parent = this.nodeParent.get(j);
        const between: number[] = [];
        while (parent !== undefined && !set.has(parent) && parent !== anchor) {
          between.push(parent);
          parent = this.nodeParent.get(parent);
        }
        // A root bone carries its ancestors' rest transform (up to the anchor part); a bone under
        // non-joint nodes, theirs. Animation keys are composed with the same matrix.
        const above = this.above(nodes, j, parent, between);
        this.boneAbove.set(j, above);
        const m = multiplyMat4(above, this.local(node));
        const rest = this.trs(m, this.localTrs(node).scale) ?? fail('skin', `bone ${id} transform`);
        if (between.length && parent !== undefined && parent !== anchor)
          this.loss('bone-between-nodes');
        bones.push({
          id,
          name: [...String(node.name ?? id)].slice(0, characterLimits.nameCodePoints).join(''),
          parentId:
            parent === undefined || parent === anchor ? null : (this.jointBone.get(parent) ?? null),
          rest: convertTransform(rest),
        });
      }
      if (anchor !== undefined) this.skeletonAnchor.set(skeletonId, anchor);
      this.doc.skeletons.push({ id: skeletonId, name, parentPartId: null, bones });
    }
  }

  readParts(nodes: unknown[], inScene: Set<number>) {
    const depth = (j: number) => {
      let d = 0;
      for (let at = this.nodeParent.get(j); at !== undefined; at = this.nodeParent.get(at)) d++;
      return d;
    };
    // Parents first, so a part's parent part exists when it is read.
    const meshNodes = [...inScene]
      .filter((i) => obj(nodes[i]).mesh !== undefined)
      .sort((a, b) => depth(a) - depth(b) || a - b);
    const isMesh = new Set(meshNodes);
    if (meshNodes.length > characterLimits.parts) fail('limit', 'parts');
    for (const i of meshNodes) {
      const node = obj(nodes[i]);
      const meshIndex = int(node.mesh, `nodes[${i}].mesh`);
      const mesh = obj(arr(this.json.meshes)[meshIndex]);
      const partId = this.claim(this.nodeId(nodes, i, 'part'), 'part');
      const prims = arr(mesh.primitives).map((p, k) =>
        this.primitive(obj(p), `meshes[${meshIndex}].primitives[${k}]`),
      );
      if (!prims.length) fail('primitive', `meshes[${meshIndex}] has no primitives`);
      const skinIndex = node.skin === undefined ? undefined : int(node.skin, 'skin');
      const skin = skinIndex === undefined ? undefined : obj(arr(this.json.skins)[skinIndex]);
      const joints = skin ? arr(skin.joints).map((j) => j as number) : [];
      const targetNames = arr(obj(mesh.extras).targetNames).map(String);
      const targetCount = prims[0].targets.length;
      if (prims.some((p) => p.targets.length !== targetCount))
        fail('primitive', `meshes[${meshIndex}] targets`);
      // C6d: morph IDs this editor wrote (`mesh.extras.ep_morph_ids`), one per target, else none.
      const given = obj(mesh.extras).ep_morph_ids;
      let morphIds: string[] | undefined;
      if (given !== undefined) {
        if (!Array.isArray(given) || given.length !== targetCount)
          fail('id', `meshes[${meshIndex}] ep_morph_ids`);
        morphIds = (given as unknown[]).map((id) =>
          this.idOf({ extras: { ep_id: id } }, 'morph', ''),
        );
      }
      const { epm, slots } = this.weld(prims, joints, targetCount, partId, targetNames, morphIds);
      // A mesh past the asset format's limits (e.g. morph targets) is a typed refusal too.
      let bytes: Uint8Array;
      try {
        bytes = encodeEpm(epm);
      } catch (e) {
        if (!(e instanceof MeshAssetError)) throw e;
        throw new GltfImportError(
          e.problem === 'limit' ? 'limit' : 'primitive',
          `meshes[${meshIndex}]: ${e.detail}`,
        );
      }
      const assetId = this.claim(shortId(`mesh:${partId}`), 'mesh');
      this.doc.assets.push({
        id: assetId,
        kind: 'mesh-epm',
        sha256: epmSha256(bytes),
        byteLength: bytes.length,
        mediaType: characterAssetMediaTypes['mesh-epm'],
      });
      this.assets.set(assetId, bytes);
      this.meshes.set(assetId, epm);
      // A part keeps its nearest part ancestor as parent, so it follows that part's animation;
      // nodes between them are folded in. Skinned parts are moved by their bones only.
      let parent = this.nodeParent.get(i);
      const between: number[] = [];
      while (parent !== undefined && !isMesh.has(parent)) {
        between.push(parent);
        parent = this.nodeParent.get(parent);
      }
      // Schema 1 has no part-on-bone attachment: a part under a joint stays where it rests.
      for (let at = this.nodeParent.get(i); at !== undefined && at !== parent; )
        if (this.jointBone.has(at)) {
          this.loss('part-under-bone');
          break;
        } else at = this.nodeParent.get(at);
      const above = this.above(nodes, i, parent, between);
      this.partAbove.set(i, above);
      const rest =
        this.trs(multiplyMat4(above, this.local(node)), this.localTrs(node).scale) ??
        fail('node', `nodes[${i}] transform`);
      this.doc.parts.push({
        id: partId,
        name: [...String(node.name ?? mesh.name ?? partId)]
          .slice(0, characterLimits.nameCodePoints)
          .join(''),
        parentId: parent === undefined ? null : (this.nodePart.get(parent) ?? null),
        transform: convertTransform(rest),
        mesh: assetId,
        materials: slots.map((m) => this.material(m)),
        visible: true,
      });
      this.nodePart.set(i, partId);
      if (skin) {
        const ibm =
          skin.inverseBindMatrices === undefined
            ? joints.map(() => identityMat4())
            : this.accessor(skin.inverseBindMatrices, 'inverseBindMatrices', 'MAT4');
        if (ibm.length !== joints.length) fail('skin', 'inverseBindMatrices count');
        const skeleton = this.doc.skeletons.find((s) =>
          s.bones.some((b) => b.id === this.jointBone.get(joints[0])),
        )!;
        const bound = new Map<string, number[]>();
        joints.forEach((j, k) => bound.set(this.jointBone.get(j)!, convertMatrix(ibm[k])));
        this.doc.skins.push({
          id: this.claim(shortId(`skin:${partId}`), 'skin'),
          partId,
          skeletonId: skeleton.id,
          inverseBind: epm.boneIds.map((boneId) => ({ boneId, matrix: bound.get(boneId)! })),
        });
        if (epm.boneIds.some((b) => !skeleton.bones.some((x) => x.id === b)))
          fail('skin', `part ${partId} uses joints of two skeletons`);
      }
      // A node's own weights override its mesh's defaults.
      const weights = arr(node.weights ?? mesh.weights);
      epm.morphs.forEach((m, k) =>
        this.doc.morphs.push({
          id: m.id,
          partId,
          name: [...(targetNames[k] ?? `Target ${k}`)]
            .slice(0, characterLimits.nameCodePoints)
            .join(''),
          weight: typeof weights[k] === 'number' ? (weights[k] as number) : 0,
        }),
      );
    }
  }
  primitive(p: J, what: string): Prim {
    const mode = p.mode === undefined ? 4 : p.mode;
    if (mode !== 4) fail('primitive', `${what} mode ${String(mode)} (only triangles)`);
    if (obj(p.extensions).KHR_draco_mesh_compression)
      fail('required-extension', 'KHR_draco_mesh_compression');
    const at = obj(p.attributes);
    if (at.POSITION === undefined) fail('primitive', `${what} has no POSITION`);
    const positions = this.accessor(at.POSITION, `${what} POSITION`, 'VEC3');
    const n = positions.length;
    const same = (a: number[][] | undefined, name: string) => {
      if (a && a.length !== n) fail('primitive', `${what} ${name} count`);
      return a;
    };
    const indices =
      p.indices === undefined
        ? positions.map((_, i) => i)
        : this.accessor(p.indices, `${what} indices`, 'SCALAR').map((e) => e[0]);
    if (indices.length % 3) fail('primitive', `${what} index count`);
    if (indices.some((i) => !Number.isInteger(i) || i < 0 || i >= n))
      fail('primitive', `${what} index range`);
    if (at.TEXCOORD_1 !== undefined) this.loss('second-uv-set');
    if (at.COLOR_0 !== undefined) this.loss('vertex-colors');
    if (at.JOINTS_1 !== undefined) this.loss('more-than-four-influences');
    // Morphs keep position deltas only; shading follows the morphed faces instead of authored
    // normal or tangent deltas.
    for (const [k, t] of arr(p.targets).entries())
      for (const attr of ['NORMAL', 'TANGENT'])
        if (
          obj(t)[attr] !== undefined &&
          this.accessor(obj(t)[attr], `${what} target ${k} ${attr}`, 'VEC3').some((e) =>
            e.some((x) => x),
          )
        )
          this.loss('morph-normals');
    if ((at.JOINTS_0 !== undefined) !== (at.WEIGHTS_0 !== undefined))
      fail('primitive', `${what} JOINTS_0 and WEIGHTS_0`);
    return {
      positions,
      normals: same(
        at.NORMAL === undefined ? undefined : this.accessor(at.NORMAL, `${what} NORMAL`, 'VEC3'),
        'NORMAL',
      ),
      uvs: same(
        at.TEXCOORD_0 === undefined
          ? undefined
          : this.accessor(at.TEXCOORD_0, `${what} TEXCOORD_0`, 'VEC2'),
        'TEXCOORD_0',
      ),
      joints: same(
        at.JOINTS_0 === undefined
          ? undefined
          : this.accessor(at.JOINTS_0, `${what} JOINTS_0`, 'VEC4'),
        'JOINTS_0',
      ),
      weights: same(
        at.WEIGHTS_0 === undefined
          ? undefined
          : this.accessor(at.WEIGHTS_0, `${what} WEIGHTS_0`, 'VEC4'),
        'WEIGHTS_0',
      ),
      indices,
      material: p.material === undefined ? undefined : int(p.material, `${what} material`),
      targets: arr(p.targets).map(
        (t, k) =>
          same(
            this.accessor(
              obj(t).POSITION ?? fail('primitive', `${what} target ${k} without POSITION`),
              `${what} target ${k}`,
              'VEC3',
            ),
            'target',
          )!,
      ),
    };
  }
  /**
   * Merges a mesh's primitives into one EPM mesh. Vertices that share position, normal and
   * weights are welded (smooth areas become one vertex; hard edges and UV seams keep theirs, with
   * the UV per corner). Degenerate triangles (a repeated vertex) are dropped.
   */
  weld(
    prims: Prim[],
    joints: number[],
    targets: number,
    partId: string,
    targetNames: string[],
    morphIds?: string[],
  ) {
    const keyOf = new Map<string, number>();
    const pos: number[] = [];
    const vWeights: [number, number][][] = [];
    // Authored normal per vertex, and the area-weighted face normal sum the display rebuilds.
    const vNormal: (number[] | null)[] = [];
    const faceSum: number[] = [];
    const deltas: number[][] = Array.from({ length: targets }, () => []);
    const sizes: number[] = [],
      idx: number[] = [],
      mats: number[] = [],
      uvs: number[] = [];
    const slots: (number | undefined)[] = [];
    let anyUv = false,
      dropped = 0;
    const boneIds: string[] = [];
    const boneIndex = new Map<string, number>();
    for (const [primIndex, prim] of prims.entries()) {
      let slot = slots.indexOf(prim.material);
      if (slot < 0) {
        slot = slots.length;
        slots.push(prim.material);
      }
      if (prim.uvs) anyUv = true;
      const norms = prim.positions.map((_, i) => {
        const w: [number, number][] = [];
        if (prim.joints && prim.weights && joints.length)
          for (let k = 0; k < 4; k++) {
            const value = prim.weights[i][k];
            if (value <= 0) continue;
            const joint = joints[prim.joints[i][k]];
            const bone = joint === undefined ? undefined : this.jointBone.get(joint);
            if (!bone) fail('skin', 'JOINTS_0 outside the skin');
            const existing = w.find(([b]) => b === boneIndexOf(bone!));
            if (existing) existing[1] += value;
            else w.push([boneIndexOf(bone!), value]);
          }
        const sum = w.reduce((s, [, x]) => s + x, 0);
        return sum > 0
          ? w.map(([b, x]) => [b, x / sum] as [number, number]).sort((a, b) => a[0] - b[0])
          : [];
      });
      // Without NORMAL, glTF draws every face flat, also once skin or morphs bend faces that are
      // coplanar at rest: each face keeps its own corners (the face joins the weld key), so the
      // display's smooth normals equal the face normal.
      const keyOfCorner = (i: number, flat: string | null) =>
        JSON.stringify([
          prim.positions[i],
          prim.normals?.[i] ?? flat,
          norms[i].map(([b, x]) => [b, Math.round(x * 1e6)]),
          prim.targets.map((t) => t[i]),
        ]);
      const vertexOf = (key: string, i: number) => {
        const done = keyOf.get(key);
        if (done !== undefined) return done;
        const v = pos.length / 3;
        if (v >= epmLimits.vertices) fail('limit', 'vertices');
        keyOf.set(key, v);
        pos.push(...point(prim.positions[i]));
        vWeights.push(norms[i]);
        vNormal.push(prim.normals?.[i] ?? null);
        faceSum.push(0, 0, 0);
        prim.targets.forEach((t, k) => deltas[k].push(...point(t[i])));
        return v;
      };
      // Keys first, then vertices in source order (as the file lists them), then faces.
      const faces: { t: number; keys: string[]; n: number[] }[] = [];
      for (let t = 0; t < prim.indices.length; t += 3) {
        const corners = [prim.indices[t], prim.indices[t + 1], prim.indices[t + 2]];
        const [a, b, c] = corners.map((i) => prim.positions[i]);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
          w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const flat = prim.normals ? null : `${primIndex}/${t}`;
        const keys = corners.map((i) => keyOfCorner(i, flat));
        if (keys[0] === keys[1] || keys[1] === keys[2] || keys[0] === keys[2]) {
          dropped++;
          continue;
        }
        faces.push({ t, keys, n });
      }
      const wanted = new Map<string, number>();
      for (const { t, keys } of faces)
        keys.forEach((key, k) => {
          if (!wanted.has(key)) wanted.set(key, prim.indices[t + k]);
        });
      [...wanted].sort((x, y) => x[1] - y[1]).forEach(([key, i]) => vertexOf(key, i));
      for (const { t, keys, n } of faces) {
        const f = keys.map((key) => keyOf.get(key)!);
        sizes.push(3);
        idx.push(...f);
        for (const v of f) for (let k = 0; k < 3; k++) faceSum[3 * v + k] += n[k];
        mats.push(slot);
        for (let k = 0; k < 3; k++) {
          const uv = prim.uvs?.[prim.indices[t + k]] ?? [0, 0];
          // glTF's v runs down the image; the mesh's runs up (as three.js flips on upload).
          uvs.push(uv[0], 1 - uv[1]);
        }
      }
    }
    function boneIndexOf(id: string) {
      let i = boneIndex.get(id);
      if (i === undefined) {
        i = boneIds.length;
        boneIds.push(id);
        boneIndex.set(id, i);
      }
      return i;
    }
    if (dropped) this.loss('degenerate-triangles', dropped);
    // EPM keeps no normals: the display derives them from the faces. Report authored normals
    // that point elsewhere (custom or weighted normals), as their shading is not kept.
    let changed = 0;
    vNormal.forEach((a, v) => {
      if (!a) return;
      const g = faceSum.slice(3 * v, 3 * v + 3);
      const lg = Math.hypot(g[0], g[1], g[2]),
        la = Math.hypot(a[0], a[1], a[2]);
      if (lg === 0 || la === 0) return;
      if ((g[0] * a[0] + g[1] * a[1] + g[2] * a[2]) / (lg * la) < authoredNormalCos) changed++;
    });
    if (changed) this.loss('authored-normals', changed);
    if (!sizes.length) fail('primitive', `part ${partId} has no triangles`);
    const v = pos.length / 3;
    const epm: EpmMesh = {
      positions: new Float32Array(pos),
      faceSizes: new Uint32Array(sizes),
      faceIndices: new Uint32Array(idx),
      faceMaterials: new Uint16Array(mats),
      boneIds,
      morphs: deltas.map((d, k) => ({
        id: this.claim(
          morphIds?.[k] ??
            shortId(
              this.ids.has(shortId(`morph:${partId}/${targetNames[k] ?? k}`))
                ? `morph:${partId}/${targetNames[k] ?? k}#${k}`
                : `morph:${partId}/${targetNames[k] ?? k}`,
            ),
          'morph',
        ),
        deltas: new Float32Array(d),
      })),
    };
    if (anyUv) epm.uvs = new Float32Array(uvs);
    if (vWeights.some((w) => w.length)) {
      const offsets = new Uint32Array(v + 1);
      const bones: number[] = [],
        values: number[] = [];
      vWeights.forEach((w, i) => {
        // Float32 rounding: renormalise once more after storing.
        const s = w.reduce((a, [, x]) => a + Math.fround(x), 0);
        for (const [b, x] of w) {
          bones.push(b);
          values.push(x / s);
        }
        offsets[i + 1] = bones.length;
      });
      epm.weights = { offsets, bones: new Uint16Array(bones), values: new Float32Array(values) };
    }
    return { epm, slots };
  }

  readAnimations(nodes: unknown[]) {
    const anims = arr(this.json.animations);
    if (anims.length > gltfImportLimits.animations) fail('limit', 'animations');
    anims.forEach((a, ai) => {
      const anim = obj(a);
      const name = typeof anim.name === 'string' && anim.name ? anim.name : `#${ai}`;
      const actionId = this.claim(this.idOf(anim, 'action', name), 'action');
      const samplers = arr(anim.samplers).map(obj);
      const tracks: CharacterTrack[] = [];
      let duration = 1;
      for (const [ci, c] of arr(anim.channels).map(obj).entries()) {
        const target = obj(c.target);
        const path = target.path;
        if (target.node === undefined) {
          this.loss('channel-without-node');
          continue;
        }
        const node = int(
          target.node,
          `animations[${ai}].channels[${ci}].target.node`,
          nodes.length - 1,
        );
        // A path this importer does not keep is dropped before its sampler is read.
        if (!['translation', 'rotation', 'scale', 'weights'].includes(path as string)) {
          this.loss(`channel:${String(path)}`);
          continue;
        }
        const sampler = samplers[int(c.sampler, 'sampler', samplers.length - 1)];
        const times = this.accessor(sampler.input, 'sampler input', 'SCALAR').map((e) => e[0]);
        let values = this.accessor(
          sampler.output,
          'sampler output',
          path === 'rotation' ? 'VEC4' : path === 'weights' ? 'SCALAR' : 'VEC3',
        );
        const interpolation = sampler.interpolation ?? 'LINEAR';
        if (!['LINEAR', 'STEP', 'CUBICSPLINE'].includes(interpolation as string))
          fail('animation', 'interpolation');
        const per =
          path === 'weights'
            ? values.length / times.length / (interpolation === 'CUBICSPLINE' ? 3 : 1)
            : 1;
        if (interpolation === 'CUBICSPLINE') {
          // Each key holds in-tangent, value, out-tangent: check that before taking the values.
          if (values.length !== times.length * per * 3 || !Number.isInteger(per))
            fail('animation', 'output count');
          // Keep each key's value, drop its tangents.
          const groups: number[][] = [];
          for (let k = 0; k < times.length; k++)
            for (let m = 0; m < per; m++) groups.push(values[(3 * k + 1) * per + m]);
          values = groups;
          this.loss('cubic-spline-tangents');
        }
        if (values.length !== times.length * per || !Number.isInteger(per))
          fail('animation', 'output count');
        const ticks = times.map((t) => {
          if (!(t >= 0)) fail('animation', 'negative time');
          return Math.round(t * 240000);
        });
        for (let k = 1; k < ticks.length; k++)
          if (ticks[k] <= ticks[k - 1]) fail('animation', 'key times collide');
        if (ticks.length) duration = Math.max(duration, ticks[ticks.length - 1]);
        const easing =
          interpolation === 'STEP' ? ({ type: 'hold' } as const) : ({ type: 'linear' } as const);
        const keyed = (trackId: string, vals: (number | Vec3 | Quat)[]): CharacterKey[] =>
          ticks.map((tick, k) => ({
            id: shortId(`${trackId}#${k}`),
            tick,
            value: vals[k],
            easing,
          }));
        if (path === 'weights') {
          const partId = this.nodePart.get(node);
          const morphs = this.doc.morphs.filter((m) => m.partId === partId);
          if (!partId || morphs.length !== per) {
            this.loss('weights-channel-unmatched');
            continue;
          }
          morphs.forEach((m, k) => {
            const id = shortId(`${actionId}/${m.id}/weight`);
            tracks.push({
              id: this.claim(id, 'track'),
              target: { kind: 'morph', id: m.id, property: 'weight' },
              keys: keyed(
                id,
                values
                  .map((_, n) => n)
                  .filter((n) => n % per === k)
                  .map((n) => values[n][0]),
              ),
            });
          });
          continue;
        }
        if (!['translation', 'rotation', 'scale'].includes(path as string)) {
          this.loss(`channel:${String(path)}`);
          continue;
        }
        const prop = path as 'translation' | 'rotation' | 'scale';
        const bone = this.jointBone.get(node);
        const part = this.nodePart.get(node);
        if (!bone && !part) {
          this.loss('channel-on-other-node');
          continue;
        }
        // A mesh node that is also a joint is both a part and a bone: both get the track, each
        // with the static transform above it in its own hierarchy (as its rest pose).
        const restTrs = this.localTrs(obj(nodes[node]));
        const targets = [
          ...(bone
            ? [
                {
                  kind: 'bone' as const,
                  id: bone,
                  above: this.boneAbove.get(node)!,
                  stored: this.doc.skeletons.flatMap((s) => s.bones).find((b) => b.id === bone)!
                    .rest,
                },
              ]
            : []),
          ...(part
            ? [
                {
                  kind: 'part' as const,
                  id: part,
                  above: this.partAbove.get(node)!,
                  stored: this.doc.parts.find((p) => p.id === part)!.transform,
                },
              ]
            : []),
        ];
        for (const target of targets) {
          let coupled = false;
          const converted = values.map((v) => {
            const trs: Transform3 = {
              ...restTrs,
              ...(prop === 'translation'
                ? { translation: v as Vec3 }
                : prop === 'rotation'
                  ? { rotation: normalizeQuat(v as Quat) }
                  : { scale: v as Vec3 }),
            };
            // Keep the source's scale signs, so a mirroring key stays a scale key.
            const world = this.trs(multiplyMat4(target.above, composeMat4(trs)), trs.scale);
            if (!world) fail('animation', 'singular key');
            const c = convertTransform(world!);
            // The track replaces one component of the stored rest: report keys needing the others.
            if (!sameMat4(composeMat4({ ...target.stored, [prop]: c[prop] }), composeMat4(c)))
              coupled = true;
            return c[prop];
          });
          if (coupled) this.loss('coupled-key');
          const id = shortId(`${actionId}/${target.id}/${prop}`);
          tracks.push({
            id: this.claim(id, 'track'),
            target: { kind: target.kind, id: target.id, property: prop },
            keys: keyed(id, converted),
          });
          for (const key of tracks[tracks.length - 1].keys) this.claim(key.id, 'key');
        }
      }
      for (const t of tracks)
        if (t.target.kind === 'morph') for (const key of t.keys) this.claim(key.id, 'key');
      const action: CharacterAction = {
        id: actionId,
        name: [...name].slice(0, characterLimits.nameCodePoints).join(''),
        duration,
        frameRate: { numerator: 30, denominator: 1 },
        tracks,
      };
      this.doc.actions.push(action);
    });
  }

  readVrm(): GltfImport['vrm'] {
    const ext = obj(this.json.extensions);
    const text = (v: unknown) =>
      typeof v === 'string'
        ? v
        : Array.isArray(v)
          ? v.filter((x) => typeof x === 'string').join(', ')
          : typeof v === 'boolean'
            ? String(v)
            : undefined;
    const pick = (meta: J, keys: string[]) => {
      const out: Record<string, string> = {};
      for (const k of keys) {
        const t = text(meta[k]);
        if (t !== undefined && t !== '') out[k] = [...t].slice(0, 1024).join('');
      }
      return out;
    };
    if (ext.VRMC_vrm) {
      this.loss('vrm-humanoid');
      if (obj(ext.VRMC_vrm).expressions) this.loss('vrm-expressions');
      if (ext.VRMC_springBone) this.loss('vrm-spring-bones');
      return {
        version: '1',
        meta: pick(obj(obj(ext.VRMC_vrm).meta), [
          'name',
          'version',
          'authors',
          'copyrightInformation',
          'contactInformation',
          'licenseUrl',
          'avatarPermission',
          'allowExcessivelyViolentUsage',
          'allowExcessivelySexualUsage',
          'commercialUsage',
          'allowPoliticalOrReligiousUsage',
          'allowAntisocialOrHateUsage',
          'creditNotation',
          'allowRedistribution',
          'modification',
          'otherLicenseUrl',
        ]),
      };
    }
    if (ext.VRM) {
      this.loss('vrm-humanoid');
      if (obj(ext.VRM).blendShapeMaster) this.loss('vrm-expressions');
      if (obj(ext.VRM).secondaryAnimation) this.loss('vrm-spring-bones');
      return {
        version: '0',
        meta: pick(obj(obj(ext.VRM).meta), [
          'title',
          'version',
          'author',
          'contactInformation',
          'reference',
          'allowedUserName',
          'violentUssageName',
          'sexualUssageName',
          'commercialUssageName',
          'otherPermissionUrl',
          'licenseName',
          'otherLicenseUrl',
        ]),
      };
    }
    return undefined;
  }
}

function dataUri(uri: string): Uint8Array {
  const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(uri);
  if (!m || !m[1]) fail('buffer', 'data URI is not base64');
  let raw: string;
  try {
    raw = atob(m![2]);
  } catch {
    return fail('buffer', 'data URI');
  }
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
/** glTF's linear base colour factor as `#rrggbb` sRGB. */
function srgbHex(c: number[]): string {
  const s = (x: number) => {
    const v = Math.min(Math.max(x, 0), 1);
    const e = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(e * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${s(c[0])}${s(c[1])}${s(c[2])}`;
}
