import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

/**
 * FEM 1 (ADR 020): the immutable byte form of one finite-element mesh of a solid. Nodes are
 * millimetres. Elements are linear (tet4) or quadratic (tet10) tetrahedra in VTK node order:
 * corners 0–3, then the mid-edge nodes of edges 01, 12, 02, 03, 13, 23. Boundary faces carry the
 * index of the analysis-shape face they were meshed from (`tag`), and edge node chains the index
 * of the analysis-shape edge, so a load is mapped to the mesh by those indices only, never by
 * nearness (docs/cad/r3-analysis.md, 荷重・拘束の引き継ぎ).
 */
export type FemElementType = 'tet4' | 'tet10';
export interface FemMesh {
  type: FemElementType;
  /** x, y, z per node (mm). */
  nodes: Float64Array;
  /** `nodesPerElement(type)` node indices per element. The corner tetrahedron has positive volume. */
  elements: Uint32Array;
  /** Faces of the analysis shape, and edges: the ranges `tag`s and `edges` index. */
  shapeFaces: number;
  shapeEdges: number;
  /** One entry per boundary face: its element, its local face (`localFaces`) and its shape face. */
  boundary: { elements: Uint32Array; localFaces: Uint8Array; tags: Uint32Array };
  /** The nodes on each shape edge, in order along it: `offsets` has `shapeEdges + 1` entries. */
  edges: { offsets: Uint32Array; nodes: Uint32Array };
}

/** Corner nodes of local face k, the face opposite corner k, wound outward. */
export const localFaces: readonly (readonly [number, number, number])[] = Object.freeze([
  [1, 2, 3],
  [0, 3, 2],
  [0, 1, 3],
  [0, 2, 1],
]);
/** Mid-edge node (tet10 index) of the edge between two corners. */
export const tet10Edges: readonly (readonly [number, number])[] = Object.freeze([
  [0, 1],
  [1, 2],
  [0, 2],
  [0, 3],
  [1, 3],
  [2, 3],
]);
export const nodesPerElement = (type: FemElementType) => (type === 'tet4' ? 4 : 10);

/** Format limits: what any FEM 1 asset may hold. The browser solver has its own, smaller ones. */
export const femLimits = Object.freeze({
  bytes: 64 * 1024 * 1024,
  nodes: 1_000_000,
  elements: 600_000,
  boundaryFaces: 1_000_000,
  shapeFaces: 65_536,
  shapeEdges: 262_144,
  edgeNodes: 2_000_000,
  coordinateMm: 10_000_000,
  metaBytes: 4096,
});
export type FemLimits = { -readonly [K in keyof typeof femLimits]: number };

export type FemAssetProblem =
  | 'too-large'
  | 'header'
  | 'sections'
  | 'meta'
  | 'length'
  | 'not-finite'
  | 'index'
  | 'element'
  | 'orientation'
  | 'boundary'
  | 'edge'
  | 'limit';
/** Every refusal of a FEM asset; nothing is repaired. */
export class FemAssetError extends Error {
  constructor(
    readonly problem: FemAssetProblem,
    readonly detail: string,
  ) {
    super(`fem-asset-invalid: ${problem}: ${detail}`);
    this.name = 'FemAssetError';
  }
}
const fail = (problem: FemAssetProblem, detail: string): never => {
  throw new FemAssetError(problem, detail);
};

export const femMediaType = 'model/x-editor-platform-fem';

/** Six times the signed volume of the corner tetrahedron of element `e`. */
export function cornerVolume6(nodes: Float64Array, elements: Uint32Array, npe: number, e: number) {
  const p = (k: number) => elements[e * npe + k]! * 3;
  const a = p(0),
    b = p(1),
    c = p(2),
    d = p(3);
  const ux = nodes[b]! - nodes[a]!,
    uy = nodes[b + 1]! - nodes[a + 1]!,
    uz = nodes[b + 2]! - nodes[a + 2]!;
  const vx = nodes[c]! - nodes[a]!,
    vy = nodes[c + 1]! - nodes[a + 1]!,
    vz = nodes[c + 2]! - nodes[a + 2]!;
  const wx = nodes[d]! - nodes[a]!,
    wy = nodes[d + 1]! - nodes[a + 1]!,
    wz = nodes[d + 2]! - nodes[a + 2]!;
  return ux * (vy * wz - vz * wy) - uy * (vx * wz - vz * wx) + uz * (vx * wy - vy * wx);
}

/** Key of a corner triangle, independent of winding and start. */
const faceKey = (a: number, b: number, c: number) => {
  const s = [a, b, c].sort((x, y) => x - y);
  return `${s[0]},${s[1]},${s[2]}`;
};

/**
 * Checks every array of a mesh in memory, as the decoder does; throws `FemAssetError`. A boundary
 * face must be a face of exactly one element (on the outside), and may be listed once.
 */
export function checkFemMesh(mesh: FemMesh, limits: FemLimits = { ...femLimits }): void {
  if (mesh.type !== 'tet4' && mesh.type !== 'tet10') fail('element', 'type');
  const npe = nodesPerElement(mesh.type);
  const n = mesh.nodes.length / 3;
  if (!Number.isInteger(n)) fail('length', 'nodes');
  if (n > limits.nodes) fail('limit', 'nodes');
  for (let i = 0; i < mesh.nodes.length; i++) {
    const x = mesh.nodes[i]!;
    if (!Number.isFinite(x)) fail('not-finite', `nodes[${i}]`);
    if (Math.abs(x) > limits.coordinateMm) fail('limit', `nodes[${i}]`);
  }
  const m = mesh.elements.length / npe;
  if (!Number.isInteger(m)) fail('length', 'elements');
  if (m > limits.elements) fail('limit', 'elements');
  if (m === 0) fail('element', 'no elements');
  for (let e = 0; e < m; e++) {
    for (let a = 0; a < npe; a++) {
      const ia = mesh.elements[e * npe + a]!;
      if (ia >= n) fail('index', `elements[${e}]`);
      for (let b = a + 1; b < npe; b++)
        if (mesh.elements[e * npe + b] === ia) fail('element', `elements[${e}] repeats a node`);
    }
    if (!(cornerVolume6(mesh.nodes, mesh.elements, npe, e) > 0))
      fail('orientation', `elements[${e}]`);
  }
  if (!Number.isSafeInteger(mesh.shapeFaces) || mesh.shapeFaces < 0) fail('meta', 'shapeFaces');
  if (mesh.shapeFaces > limits.shapeFaces) fail('limit', 'shapeFaces');
  if (!Number.isSafeInteger(mesh.shapeEdges) || mesh.shapeEdges < 0) fail('meta', 'shapeEdges');
  if (mesh.shapeEdges > limits.shapeEdges) fail('limit', 'shapeEdges');
  const { elements: be, localFaces: bl, tags } = mesh.boundary;
  if (bl.length !== be.length || tags.length !== be.length) fail('length', 'boundary');
  if (be.length > limits.boundaryFaces) fail('limit', 'boundaryFaces');
  // How many elements use each corner triangle: a boundary face is used by one.
  const uses = new Map<string, number>();
  for (let e = 0; e < m; e++)
    for (const f of localFaces) {
      const k = faceKey(
        mesh.elements[e * npe + f[0]]!,
        mesh.elements[e * npe + f[1]]!,
        mesh.elements[e * npe + f[2]]!,
      );
      const u = (uses.get(k) ?? 0) + 1;
      if (u > 2) fail('element', `face ${k} of more than two elements`);
      uses.set(k, u);
    }
  const listed = new Set<string>();
  for (let i = 0; i < be.length; i++) {
    const e = be[i]!,
      lf = bl[i]!;
    if (e >= m) fail('index', `boundary[${i}] element`);
    if (lf > 3) fail('boundary', `boundary[${i}] local face`);
    if (tags[i]! >= mesh.shapeFaces) fail('index', `boundary[${i}] tag`);
    const f = localFaces[lf]!;
    const k = faceKey(
      mesh.elements[e * npe + f[0]]!,
      mesh.elements[e * npe + f[1]]!,
      mesh.elements[e * npe + f[2]]!,
    );
    if (uses.get(k) !== 1) fail('boundary', `boundary[${i}] is an inner face`);
    if (listed.has(k)) fail('boundary', `boundary[${i}] listed twice`);
    listed.add(k);
  }
  const { offsets, nodes: en } = mesh.edges;
  if (offsets.length !== mesh.shapeEdges + 1 || offsets[0] !== 0) fail('length', 'edges.offsets');
  if (offsets[mesh.shapeEdges] !== en.length) fail('length', 'edges.nodes');
  if (en.length > limits.edgeNodes) fail('limit', 'edgeNodes');
  for (let k = 0; k < mesh.shapeEdges; k++) {
    if (offsets[k + 1]! < offsets[k]!) fail('edge', `edges[${k}] offsets`);
    if (offsets[k + 1]! - offsets[k]! === 1) fail('edge', `edges[${k}] has one node`);
  }
  for (let i = 0; i < en.length; i++) if (en[i]! >= n) fail('index', `edges.nodes[${i}]`);
}

const MAGIC = [0x45, 0x50, 0x46, 0x31]; // "EPF1"
const VERSION = 1;
const HEADER = 16;
const ENTRY = 12;
const tags = ['META', 'NODE', 'ELEM', 'BELM', 'BLFC', 'BTAG', 'EOFF', 'ENOD'] as const;
type Tag = (typeof tags)[number];
const tagCode = (t: string) =>
  t.charCodeAt(0) | (t.charCodeAt(1) << 8) | (t.charCodeAt(2) << 16) | (t.charCodeAt(3) << 24);
const tagName = (c: number) =>
  String.fromCharCode(c & 255, (c >>> 8) & 255, (c >>> 16) & 255, (c >>> 24) & 255);
interface Meta {
  type: FemElementType;
  nodes: number;
  elements: number;
  boundaryFaces: number;
  shapeFaces: number;
  shapeEdges: number;
  edgeNodes: number;
}
const metaKeys: (keyof Meta)[] = [
  'type',
  'nodes',
  'elements',
  'boundaryFaces',
  'shapeFaces',
  'shapeEdges',
  'edgeNodes',
];
const align = (n: number) => (n + 7) & ~7;

/**
 * The bytes of a checked mesh; the same mesh always gives the same bytes. Sections are 8-byte
 * aligned so the f64 nodes can be read in place.
 */
export function encodeFem(mesh: FemMesh, limits: FemLimits = { ...femLimits }): Uint8Array {
  checkFemMesh(mesh, limits);
  const meta: Meta = {
    type: mesh.type,
    nodes: mesh.nodes.length / 3,
    elements: mesh.elements.length / nodesPerElement(mesh.type),
    boundaryFaces: mesh.boundary.elements.length,
    shapeFaces: mesh.shapeFaces,
    shapeEdges: mesh.shapeEdges,
    edgeNodes: mesh.edges.nodes.length,
  };
  const parts: [Tag, Uint8Array][] = [
    ['META', new TextEncoder().encode(JSON.stringify(meta))],
    ['NODE', bytesOf(mesh.nodes)],
    ['ELEM', bytesOf(mesh.elements)],
    ['BELM', bytesOf(mesh.boundary.elements)],
    ['BLFC', bytesOf(mesh.boundary.localFaces)],
    ['BTAG', bytesOf(mesh.boundary.tags)],
    ['EOFF', bytesOf(mesh.edges.offsets)],
    ['ENOD', bytesOf(mesh.edges.nodes)],
  ];
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
function bytesOf(a: Float64Array | Uint32Array | Uint8Array): Uint8Array {
  if (a instanceof Uint8Array) return a.slice();
  const out = new Uint8Array(a.length * a.BYTES_PER_ELEMENT);
  const view = new DataView(out.buffer);
  for (let i = 0; i < a.length; i++) {
    if (a instanceof Float64Array) view.setFloat64(i * 8, a[i]!, true);
    else view.setUint32(i * 4, a[i]!, true);
  }
  return out;
}

/** Reads and checks FEM 1 bytes; throws `FemAssetError` on anything it does not accept. */
export function decodeFem(bytes: Uint8Array, limits: FemLimits = { ...femLimits }): FemMesh {
  if (bytes.length > limits.bytes) fail('too-large', `${bytes.length} bytes`);
  if (bytes.length < HEADER) fail('header', 'short');
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) fail('header', 'magic');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== VERSION) fail('header', 'version');
  const count = view.getUint32(8, true);
  if (view.getUint32(12, true) !== 0) fail('header', 'reserved');
  if (count !== tags.length || HEADER + count * ENTRY > bytes.length) fail('sections', 'count');
  const sections = new Map<Tag, { at: number; length: number }>();
  const spans: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const name = tagName(view.getUint32(HEADER + i * ENTRY, true));
    const at = view.getUint32(HEADER + i * ENTRY + 4, true);
    const length = view.getUint32(HEADER + i * ENTRY + 8, true);
    if (!(tags as readonly string[]).includes(name)) fail('sections', `unknown ${name}`);
    if (sections.has(name as Tag)) fail('sections', `repeated ${name}`);
    if (at % 8 || at < HEADER + count * ENTRY || at + length > bytes.length)
      fail('sections', `range ${name}`);
    sections.set(name as Tag, { at, length });
    spans.push([at, at + length]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++)
    if (spans[i]![0] < spans[i - 1]![1]) fail('sections', 'overlap');
  const meta = readMeta(bytes, sections.get('META')!, limits);
  function read<A extends Float64Array | Uint32Array | Uint8Array>(
    t: Tag,
    n: number,
    size: number,
    get: (offset: number) => number,
    Kind: new (n: number) => A,
  ): A {
    const s = sections.get(t)!;
    if (s.length !== n * size) fail('length', t);
    const out = new Kind(n);
    for (let i = 0; i < n; i++) out[i] = get(s.at + i * size);
    return out;
  }
  const f64 = (t: Tag, n: number) => read(t, n, 8, (o) => view.getFloat64(o, true), Float64Array);
  const u32 = (t: Tag, n: number) => read(t, n, 4, (o) => view.getUint32(o, true), Uint32Array);
  const u8 = (t: Tag, n: number) => read(t, n, 1, (o) => view.getUint8(o), Uint8Array);
  const mesh: FemMesh = {
    type: meta.type,
    nodes: f64('NODE', meta.nodes * 3),
    elements: u32('ELEM', meta.elements * nodesPerElement(meta.type)),
    shapeFaces: meta.shapeFaces,
    shapeEdges: meta.shapeEdges,
    boundary: {
      elements: u32('BELM', meta.boundaryFaces),
      localFaces: u8('BLFC', meta.boundaryFaces),
      tags: u32('BTAG', meta.boundaryFaces),
    },
    edges: { offsets: u32('EOFF', meta.shapeEdges + 1), nodes: u32('ENOD', meta.edgeNodes) },
  };
  checkFemMesh(mesh, limits);
  return mesh;
}
function readMeta(bytes: Uint8Array, s: { at: number; length: number }, limits: FemLimits): Meta {
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
  if (
    m === null ||
    typeof m !== 'object' ||
    Array.isArray(m) ||
    Object.keys(m).length !== metaKeys.length ||
    !metaKeys.every((k) => Object.hasOwn(m, k))
  )
    fail('meta', 'keys');
  if (m.type !== 'tet4' && m.type !== 'tet10') fail('meta', 'type');
  const count = (k: keyof Meta, max: number) => {
    const n = m[k];
    if (!Number.isSafeInteger(n) || (n as number) < 0) fail('meta', k);
    if ((n as number) > max) fail('limit', k);
    return n as number;
  };
  return {
    type: m.type as FemElementType,
    nodes: count('nodes', limits.nodes),
    elements: count('elements', limits.elements),
    boundaryFaces: count('boundaryFaces', limits.boundaryFaces),
    shapeFaces: count('shapeFaces', limits.shapeFaces),
    shapeEdges: count('shapeEdges', limits.shapeEdges),
    edgeNodes: count('edgeNodes', limits.edgeNodes),
  };
}

/** `sha256:<hex>` of asset bytes, the form content uses to name an asset. */
export const femSha256 = (bytes: Uint8Array) => `sha256:${bytesToHex(sha256(bytes))}`;

/** Total volume of the mesh's corner tetrahedra (mm³): exact for straight-sided elements. */
export function femVolume(mesh: FemMesh): number {
  const npe = nodesPerElement(mesh.type);
  let v = 0;
  for (let e = 0; e < mesh.elements.length / npe; e++)
    v += cornerVolume6(mesh.nodes, mesh.elements, npe, e);
  return v / 6;
}
