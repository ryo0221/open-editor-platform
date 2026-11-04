import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

/**
 * EPM 1 (ADR 019): the immutable byte form of one editable polygon mesh. Faces are polygons of
 * any size (n-gons), UVs are per face corner, weights are per vertex with a variable count, and
 * each morph is a delta per vertex. Positions are millimetres.
 */
export interface EpmMesh {
  /** x, y, z per vertex (mm). */
  positions: Float32Array;
  /** The vertex count of each face (3 or more). */
  faceSizes: Uint32Array;
  /** The vertices of each face in order, faces one after another. */
  faceIndices: Uint32Array;
  /** The material slot of each face. */
  faceMaterials: Uint16Array;
  /** u, v per face corner, in the order of `faceIndices`. */
  uvs?: Float32Array;
  /** Edge creases for subdivision: vertex pairs (a < b) and a weight 0–1 each. */
  creases?: { edges: Uint32Array; values: Float32Array };
  /** Skin weights: `offsets` has one more entry than vertices; bones index `boneIds`. */
  weights?: { offsets: Uint32Array; bones: Uint16Array; values: Float32Array };
  /** Bone IDs of the character the weights name. */
  boneIds: string[];
  /** Morph targets: a delta (mm) per vertex, x, y, z. */
  morphs: { id: string; deltas: Float32Array }[];
}

export const epmLimits = Object.freeze({
  bytes: 64 * 1024 * 1024,
  vertices: 500_000,
  faces: 1_000_000,
  corners: 4_000_000,
  faceSize: 64,
  bones: 512,
  influences: 8,
  morphs: 256,
  idCodePoints: 128,
  metaBytes: 256 * 1024,
});
export type EpmLimits = { -readonly [K in keyof typeof epmLimits]: number };

export type MeshAssetProblem =
  | 'too-large'
  | 'header'
  | 'sections'
  | 'meta'
  | 'length'
  | 'not-finite'
  | 'face'
  | 'index'
  | 'crease'
  | 'weights'
  | 'ids'
  | 'limit';
/** Every refusal of an EPM asset; nothing is repaired. */
export class MeshAssetError extends Error {
  constructor(
    readonly problem: MeshAssetProblem,
    readonly detail: string,
  ) {
    super(`mesh-asset-invalid: ${problem}: ${detail}`);
    this.name = 'MeshAssetError';
  }
}
const fail = (problem: MeshAssetProblem, detail: string): never => {
  throw new MeshAssetError(problem, detail);
};

export const epmMediaType = 'model/x-editor-platform-mesh';
const MAGIC = [0x45, 0x50, 0x4d, 0x31]; // "EPM1"
const VERSION = 1;
const HEADER = 16;
const ENTRY = 12;
const tags = [
  'META',
  'POSI',
  'FSIZ',
  'FIDX',
  'FMAT',
  'UVCO',
  'CRSE',
  'CRSV',
  'WOFF',
  'WBON',
  'WVAL',
  'MRPH',
] as const;
type Tag = (typeof tags)[number];
const required: Tag[] = ['META', 'POSI', 'FSIZ', 'FIDX', 'FMAT'];
const tagCode = (t: string) =>
  t.charCodeAt(0) | (t.charCodeAt(1) << 8) | (t.charCodeAt(2) << 16) | (t.charCodeAt(3) << 24);
const tagName = (c: number) =>
  String.fromCharCode(c & 255, (c >>> 8) & 255, (c >>> 16) & 255, (c >>> 24) & 255);

interface Meta {
  vertices: number;
  faces: number;
  corners: number;
  boneIds: string[];
  morphIds: string[];
}
const reserved = ['__proto__', 'constructor', 'prototype', 'toJSON'];
/** An ID as the character domain uses it: 1–128 code points, no controls or edge spaces. */
export const meshId = (v: unknown, max: number = epmLimits.idCodePoints): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  [...v].length <= max &&
  v.trim() === v &&
  !/\p{Cc}/u.test(v) &&
  !reserved.includes(v);

/** Checks every array of a mesh in memory, as the decoder does; throws `MeshAssetError`. */
export function checkEpmMesh(mesh: EpmMesh, limits: EpmLimits = { ...epmLimits }): void {
  const v = mesh.positions.length / 3;
  if (!Number.isInteger(v)) fail('length', 'positions');
  if (v > limits.vertices) fail('limit', 'vertices');
  if (mesh.faceSizes.length > limits.faces) fail('limit', 'faces');
  if (mesh.faceMaterials.length !== mesh.faceSizes.length) fail('length', 'faceMaterials');
  for (let i = 0; i < mesh.positions.length; i++)
    if (!Number.isFinite(mesh.positions[i])) fail('not-finite', `positions[${i}]`);
  let corners = 0;
  for (let f = 0; f < mesh.faceSizes.length; f++) {
    const n = mesh.faceSizes[f];
    if (n < 3 || n > limits.faceSize) fail('face', `faces[${f}] size`);
    for (let a = 0; a < n; a++) {
      const ia = mesh.faceIndices[corners + a];
      if (ia === undefined) fail('length', 'faceIndices');
      if (ia >= v) fail('index', `faces[${f}]`);
      for (let b = a + 1; b < n; b++)
        if (mesh.faceIndices[corners + b] === ia) fail('face', `faces[${f}] repeats a vertex`);
    }
    corners += n;
    if (corners > limits.corners) fail('limit', 'corners');
  }
  if (corners !== mesh.faceIndices.length) fail('length', 'faceIndices');
  if (mesh.uvs) {
    if (mesh.uvs.length !== corners * 2) fail('length', 'uvs');
    for (let i = 0; i < mesh.uvs.length; i++)
      if (!Number.isFinite(mesh.uvs[i])) fail('not-finite', `uvs[${i}]`);
  }
  if (mesh.creases) {
    const { edges, values } = mesh.creases;
    if (edges.length !== values.length * 2) fail('length', 'creases');
    const seen = new Set<string>();
    for (let i = 0; i < values.length; i++) {
      const a = edges[2 * i],
        b = edges[2 * i + 1],
        w = values[i];
      if (!(a < b) || b >= v) fail('crease', `creases[${i}] vertices`);
      if (!(w >= 0 && w <= 1)) fail('crease', `creases[${i}] value`);
      const key = `${a}:${b}`;
      if (seen.has(key)) fail('crease', `creases[${i}] repeats an edge`);
      seen.add(key);
    }
  }
  if (mesh.boneIds.length > limits.bones) fail('limit', 'bones');
  uniqueIds(mesh.boneIds, 'boneIds');
  if (mesh.weights) {
    const { offsets, bones, values } = mesh.weights;
    if (mesh.boneIds.length === 0) fail('weights', 'weights without bones');
    if (offsets.length !== v + 1 || offsets[0] !== 0) fail('length', 'weights.offsets');
    if (bones.length !== values.length || offsets[v] !== bones.length)
      fail('length', 'weights.values');
    for (let i = 0; i < v; i++) {
      const s = offsets[i],
        e = offsets[i + 1];
      if (e < s) fail('weights', `vertex ${i} offsets`);
      if (e - s > limits.influences) fail('limit', `vertex ${i} influences`);
      let sum = 0;
      for (let k = s; k < e; k++) {
        if (bones[k] >= mesh.boneIds.length) fail('index', `vertex ${i} bone`);
        for (let j = s; j < k; j++) if (bones[j] === bones[k]) fail('weights', `vertex ${i} bone`);
        const w = values[k];
        if (!Number.isFinite(w) || w <= 0 || w > 1) fail('weights', `vertex ${i} weight`);
        sum += w;
      }
      if (e > s && Math.abs(sum - 1) > 1e-3) fail('weights', `vertex ${i} sum`);
    }
  }
  if (mesh.morphs.length > limits.morphs) fail('limit', 'morphs');
  uniqueIds(
    mesh.morphs.map((m) => m.id),
    'morphIds',
  );
  mesh.morphs.forEach((m, i) => {
    if (m.deltas.length !== v * 3) fail('length', `morphs[${i}]`);
    for (let k = 0; k < m.deltas.length; k++)
      if (!Number.isFinite(m.deltas[k])) fail('not-finite', `morphs[${i}]`);
  });
}
function uniqueIds(ids: string[], what: string) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!meshId(id) || seen.has(id)) fail('ids', what);
    seen.add(id);
  }
}

/**
 * The bytes of a checked mesh. The same mesh always gives the same bytes. Refuses a mesh whose
 * metadata or whole asset would be past the limits `decodeEpm` reads with, so every asset this
 * writes can be read back.
 */
export function encodeEpm(mesh: EpmMesh, limits: EpmLimits = { ...epmLimits }): Uint8Array {
  checkEpmMesh(mesh, limits);
  const meta: Meta = {
    vertices: mesh.positions.length / 3,
    faces: mesh.faceSizes.length,
    corners: mesh.faceIndices.length,
    boneIds: [...mesh.boneIds],
    morphIds: mesh.morphs.map((m) => m.id),
  };
  const parts: [Tag, Uint8Array][] = [
    ['META', new TextEncoder().encode(JSON.stringify(meta))],
    ['POSI', bytesOf(mesh.positions)],
    ['FSIZ', bytesOf(mesh.faceSizes)],
    ['FIDX', bytesOf(mesh.faceIndices)],
    ['FMAT', bytesOf(mesh.faceMaterials)],
  ];
  if (mesh.uvs) parts.push(['UVCO', bytesOf(mesh.uvs)]);
  if (mesh.creases)
    parts.push(['CRSE', bytesOf(mesh.creases.edges)], ['CRSV', bytesOf(mesh.creases.values)]);
  if (mesh.weights)
    parts.push(
      ['WOFF', bytesOf(mesh.weights.offsets)],
      ['WBON', bytesOf(mesh.weights.bones)],
      ['WVAL', bytesOf(mesh.weights.values)],
    );
  if (mesh.morphs.length) {
    const all = new Float32Array(mesh.morphs.length * mesh.positions.length);
    mesh.morphs.forEach((m, i) => all.set(m.deltas, i * mesh.positions.length));
    parts.push(['MRPH', bytesOf(all)]);
  }
  if (parts[0][1].length > limits.metaBytes) fail('meta', 'size');
  let offset = HEADER + parts.length * ENTRY;
  const layout = parts.map(([tag, b]) => {
    offset = align(offset);
    const at = offset;
    offset += b.length;
    return { tag, at, b };
  });
  if (align(offset) > limits.bytes) fail('too-large', `${align(offset)} bytes`);
  const out = new Uint8Array(align(offset));
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, parts.length, true);
  layout.forEach(({ tag, at, b }, i) => {
    view.setUint32(HEADER + i * ENTRY, tagCode(tag), true);
    view.setUint32(HEADER + i * ENTRY + 4, at, true);
    view.setUint32(HEADER + i * ENTRY + 8, b.length, true);
    out.set(b, at);
  });
  return out;
}
const align = (n: number) => (n + 3) & ~3;
function bytesOf(a: Float32Array | Uint32Array | Uint16Array): Uint8Array {
  // Little-endian on every platform the editor runs on; the decoder reads through DataView.
  const out = new Uint8Array(a.length * a.BYTES_PER_ELEMENT);
  const view = new DataView(out.buffer);
  for (let i = 0; i < a.length; i++) {
    if (a instanceof Float32Array) view.setFloat32(i * 4, a[i], true);
    else if (a instanceof Uint32Array) view.setUint32(i * 4, a[i], true);
    else view.setUint16(i * 2, a[i], true);
  }
  return out;
}

/** Reads and checks EPM 1 bytes; throws `MeshAssetError` on anything it does not accept. */
export function decodeEpm(bytes: Uint8Array, limits: EpmLimits = { ...epmLimits }): EpmMesh {
  if (bytes.length > limits.bytes) fail('too-large', `${bytes.length} bytes`);
  if (bytes.length < HEADER) fail('header', 'short');
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) fail('header', 'magic');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== VERSION) fail('header', 'version');
  const count = view.getUint32(8, true);
  if (view.getUint32(12, true) !== 0) fail('header', 'reserved');
  if (count > tags.length || HEADER + count * ENTRY > bytes.length) fail('sections', 'count');
  const sections = new Map<Tag, { at: number; length: number }>();
  const spans: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const name = tagName(view.getUint32(HEADER + i * ENTRY, true));
    const at = view.getUint32(HEADER + i * ENTRY + 4, true);
    const length = view.getUint32(HEADER + i * ENTRY + 8, true);
    if (!(tags as readonly string[]).includes(name)) fail('sections', `unknown ${name}`);
    if (sections.has(name as Tag)) fail('sections', `repeated ${name}`);
    if (at % 4 || at < HEADER + count * ENTRY || at + length > bytes.length)
      fail('sections', `range ${name}`);
    sections.set(name as Tag, { at, length });
    spans.push([at, at + length]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++)
    if (spans[i][0] < spans[i - 1][1]) fail('sections', 'overlap');
  for (const t of required) if (!sections.has(t)) fail('sections', `missing ${t}`);
  const pairs: [Tag, Tag][] = [
    ['CRSE', 'CRSV'],
    ['WOFF', 'WVAL'],
    ['WBON', 'WVAL'],
  ];
  for (const [a, b] of pairs)
    if (sections.has(a) !== sections.has(b)) fail('sections', `${a} without ${b}`);
  const meta = readMeta(bytes, sections.get('META')!, limits);
  const f32 = (t: Tag, n: number) => read(t, n, 4, (o) => view.getFloat32(o, true), Float32Array);
  const u32 = (t: Tag, n: number) => read(t, n, 4, (o) => view.getUint32(o, true), Uint32Array);
  const u16 = (t: Tag, n: number) => read(t, n, 2, (o) => view.getUint16(o, true), Uint16Array);
  function read<A extends Float32Array | Uint32Array | Uint16Array>(
    t: Tag,
    n: number | undefined,
    size: number,
    get: (offset: number) => number,
    Kind: new (n: number) => A,
  ): A {
    const s = sections.get(t)!;
    if (s.length % size) fail('length', t);
    const len = s.length / size;
    if (n !== undefined && len !== n) fail('length', t);
    const out = new Kind(len);
    for (let i = 0; i < len; i++) out[i] = get(s.at + i * size);
    return out;
  }
  const v = meta.vertices;
  const mesh: EpmMesh = {
    positions: f32('POSI', v * 3),
    faceSizes: u32('FSIZ', meta.faces),
    faceIndices: u32('FIDX', meta.corners),
    faceMaterials: u16('FMAT', meta.faces),
    boneIds: meta.boneIds,
    morphs: [],
  };
  if (sections.has('UVCO')) mesh.uvs = f32('UVCO', meta.corners * 2);
  if (sections.has('CRSE')) {
    const values = read('CRSV', undefined, 4, (o) => view.getFloat32(o, true), Float32Array);
    mesh.creases = { edges: u32('CRSE', values.length * 2), values };
  }
  if (sections.has('WOFF')) {
    const offsets = u32('WOFF', v + 1);
    const n = offsets[v];
    mesh.weights = { offsets, bones: u16('WBON', n), values: f32('WVAL', n) };
  }
  if (meta.morphIds.length) {
    if (!sections.has('MRPH')) fail('sections', 'missing MRPH');
    const all = f32('MRPH', meta.morphIds.length * v * 3);
    mesh.morphs = meta.morphIds.map((id, i) => ({
      id,
      deltas: all.slice(i * v * 3, (i + 1) * v * 3),
    }));
  } else if (sections.has('MRPH')) fail('sections', 'MRPH without morphs');
  checkEpmMesh(mesh, limits);
  return mesh;
}
function readMeta(bytes: Uint8Array, s: { at: number; length: number }, limits: EpmLimits): Meta {
  if (s.length > limits.metaBytes) fail('meta', 'size');
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(s.at, s.at + s.length)),
    );
  } catch {
    fail('meta', 'json');
  }
  const m = value as Record<string, unknown>;
  const keys = ['vertices', 'faces', 'corners', 'boneIds', 'morphIds'];
  if (
    m === null ||
    typeof m !== 'object' ||
    Array.isArray(m) ||
    Object.keys(m).length !== keys.length ||
    !keys.every((k) => Object.hasOwn(m, k))
  )
    fail('meta', 'keys');
  const count = (k: string, max: number) => {
    const n = m[k];
    if (!Number.isSafeInteger(n) || (n as number) < 0) fail('meta', k);
    if ((n as number) > max) fail('limit', k);
    return n as number;
  };
  const ids = (k: string, max: number) => {
    const a = m[k];
    if (!Array.isArray(a)) fail('meta', k);
    if ((a as unknown[]).length > max) fail('limit', k);
    return a as string[];
  };
  return {
    vertices: count('vertices', limits.vertices),
    faces: count('faces', limits.faces),
    corners: count('corners', limits.corners),
    boneIds: ids('boneIds', limits.bones),
    morphIds: ids('morphIds', limits.morphs),
  };
}

/** `sha256:<hex>` of asset bytes, the form content uses to name an asset. */
export const epmSha256 = (bytes: Uint8Array) => `sha256:${bytesToHex(sha256(bytes))}`;
